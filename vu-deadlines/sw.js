/**
 * VU Deadlines service worker.
 * Periodic calendar sync, local cache, notifications.
 * Never reads cookies or credentials. Uses the existing VULMS session.
 */
/* global VuParser, VuStorage, VuNotifications */

importScripts("parser.js", "storage.js", "notifications.js");

var CALENDAR_URL = "https://vulms.vu.edu.pk/ActivityCalendar/ActivityCalendar.aspx";
var HOME_URL = "https://vulms.vu.edu.pk/Home.aspx";
var ORIGIN = "https://vulms.vu.edu.pk/";

var SYNC_ALARM = "vu-sync";
var NOTIFY_ALARM = "vu-notify";
var syncing = false;

function nowIso() {
  return new Date().toISOString();
}

async function fetchWithSession(url) {
  var response = await fetch(url, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    redirect: "follow"
  });
  if (!response.ok) {
    throw new Error("VULMS request failed (" + response.status + ")");
  }
  return response.text();
}

async function fetchViaOpenTab(url) {
  if (typeof url !== "string" || url.indexOf(ORIGIN) !== 0) {
    return { ok: false, error: "blocked" };
  }
  var tabs;
  try {
    tabs = await chrome.tabs.query({ url: "https://vulms.vu.edu.pk/*" });
  } catch (err) {
    return { ok: false, error: "tab-query-failed" };
  }
  if (!tabs || !tabs.length) {
    return { ok: false, error: "no-vulms-tab" };
  }
  try {
    var result = await chrome.tabs.sendMessage(tabs[0].id, {
      type: "VU_PAGE_FETCH",
      url: url
    });
    return result || { ok: false, error: "empty-response" };
  } catch (err) {
    return { ok: false, error: "content-script-unavailable" };
  }
}

/**
 * Prefer a service-worker fetch. If JsonData is missing, try an open VULMS tab
 * so we can tell "logged out" apart from "SW did not receive the session cookie".
 */
async function loadCalendarHtml() {
  var diagnostic = {
    at: nowIso(),
    serviceWorker: { reached: false, jsonDataFound: false, error: null },
    pageContext: { attempted: false, reached: false, jsonDataFound: false, error: null }
  };
  var html = null;

  try {
    html = await fetchWithSession(CALENDAR_URL);
    diagnostic.serviceWorker.reached = true;
    diagnostic.serviceWorker.jsonDataFound = VuParser.calendarLooksAuthenticated(html);
  } catch (err) {
    diagnostic.serviceWorker.error = err && err.message ? err.message : String(err);
  }

  if (html && diagnostic.serviceWorker.jsonDataFound) {
    return { html: html, fetchPath: "service-worker", diagnostic: diagnostic };
  }

  diagnostic.pageContext.attempted = true;
  var page = await fetchViaOpenTab(CALENDAR_URL);
  if (page && page.ok && page.text) {
    diagnostic.pageContext.reached = true;
    diagnostic.pageContext.jsonDataFound = VuParser.calendarLooksAuthenticated(page.text);
    if (diagnostic.pageContext.jsonDataFound) {
      return { html: page.text, fetchPath: "page-context", diagnostic: diagnostic };
    }
    diagnostic.pageContext.error = "JsonData missing";
  } else {
    diagnostic.pageContext.error = page && page.error ? page.error : "unavailable";
  }

  var error = new Error("VULMS calendar format not recognized");
  error.code = "unauthenticated-or-unrecognized";
  error.diagnostic = diagnostic;
  throw error;
}

async function loadCourseMap(fetchPath, previous) {
  var map = previous || {};
  try {
    var html = null;
    if (fetchPath === "page-context") {
      var page = await fetchViaOpenTab(HOME_URL);
      if (page && page.ok) {
        html = page.text;
      }
    }
    if (!html) {
      html = await fetchWithSession(HOME_URL);
    }
    var extracted = VuParser.extractCourseMap(html);
    if (extracted && Object.keys(extracted).length) {
      return extracted;
    }
  } catch (err) {
    /* Course names are optional. Keep whatever we already have. */
  }
  return map;
}

function failClosed(state, message, diagnostic) {
  var next = Object.assign({}, state);
  next.lastSyncAttempt = nowIso();
  next.syncStatus = state.lastSuccessfulSync ? "stale" : "error";
  next.syncError = message;
  if (diagnostic) {
    next.sessionDiagnostic = diagnostic;
  }
  return next;
}

async function syncDeadlines(reason) {
  if (syncing) {
    return VuStorage.loadState();
  }
  syncing = true;
  var state = await VuStorage.loadState();
  try {
    var loaded;
    try {
      loaded = await loadCalendarHtml();
    } catch (err) {
      var signedOutMessage = "Please sign in to VULMS to refresh deadlines.";
      var message =
        err && err.code === "unauthenticated-or-unrecognized"
          ? signedOutMessage
          : err && err.message
            ? err.message
            : "Sync failed";
      state = failClosed(state, message, err && err.diagnostic ? err.diagnostic : state.sessionDiagnostic);
      await VuStorage.saveState(state);
      return state;
    }

    var raw;
    try {
      raw = VuParser.extractJsonData(loaded.html);
    } catch (err) {
      state = failClosed(state, "Please sign in to VULMS to refresh deadlines.", loaded.diagnostic);
      await VuStorage.saveState(state);
      return state;
    }

    if (raw.length === 0 && (state.activities || []).length > 0) {
      state = failClosed(
        state,
        "Empty calendar returned; keeping previous deadlines.",
        loaded.diagnostic
      );
      state.fetchPath = loaded.fetchPath;
      await VuStorage.saveState(state);
      return state;
    }

    var fetchedAt = nowIso();
    var courseMap = await loadCourseMap(loaded.fetchPath, state.courseMap);
    var incoming = [];
    raw.forEach(function (record) {
      try {
        var activity = VuParser.normalizeActivity(record, courseMap, fetchedAt);
        if (activity) {
          incoming.push(activity);
        }
      } catch (err) {
        /* Skip a single malformed record; do not abort the sync. */
      }
    });

    if (
      incoming.length === 0 &&
      (state.activities || []).length > 0 &&
      raw.some(VuParser.isAcademicRecord)
    ) {
      state = failClosed(
        state,
        "Calendar records could not be normalized; keeping previous deadlines.",
        loaded.diagnostic
      );
      state.fetchPath = loaded.fetchPath;
      await VuStorage.saveState(state);
      return state;
    }

    state.activities = VuStorage.mergeActivities(state.activities, incoming);
    state.courseMap = courseMap;
    state.lastSuccessfulSync = fetchedAt;
    state.lastSyncAttempt = fetchedAt;
    state.syncStatus = "ok";
    state.syncError = null;
    state.fetchPath = loaded.fetchPath;
    state.sessionDiagnostic = loaded.diagnostic;
    var notifyResult = await VuNotifications.checkNotifications(state);
    state = notifyResult.state;
    await VuStorage.saveState(state);
    return state;
  } catch (err) {
    state = failClosed(
      state,
      err && err.message ? err.message : "Sync failed",
      state.sessionDiagnostic
    );
    await VuStorage.saveState(state);
    return state;
  } finally {
    syncing = false;
  }
}

async function ensureAlarms() {
  var syncAlarm = await chrome.alarms.get(SYNC_ALARM);
  if (!syncAlarm) {
    chrome.alarms.create(SYNC_ALARM, {
      delayInMinutes: 1 + Math.floor(Math.random() * 15),
      periodInMinutes: 360
    });
  }
  var notifyAlarm = await chrome.alarms.get(NOTIFY_ALARM);
  if (!notifyAlarm) {
    chrome.alarms.create(NOTIFY_ALARM, {
      delayInMinutes: 2,
      periodInMinutes: 30
    });
  }
}

async function checkRemindersOnly() {
  var state = await VuStorage.loadState();
  var result = await VuNotifications.checkNotifications(state);
  if (result.changed) {
    await VuStorage.saveState(result.state);
  }
}

chrome.runtime.onInstalled.addListener(function () {
  ensureAlarms().then(function () {
    return syncDeadlines("install");
  });
});

chrome.runtime.onStartup.addListener(function () {
  ensureAlarms().then(function () {
    return syncDeadlines("startup");
  });
});

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (!alarm) {
    return;
  }
  if (alarm.name === SYNC_ALARM) {
    ensureAlarms().then(function () {
      return syncDeadlines("alarm");
    });
  } else if (alarm.name === NOTIFY_ALARM) {
    checkRemindersOnly();
  }
});

chrome.notifications.onClicked.addListener(function (notificationId) {
  VuNotifications.openActivityFromNotification(notificationId);
});

chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
  if (!message || !message.type) {
    return;
  }
  if (message.type === "VU_SYNC_NOW") {
    syncDeadlines("manual").then(sendResponse);
    return true;
  }
  if (message.type === "VU_GET_STATE") {
    VuStorage.loadState().then(sendResponse);
    return true;
  }
  if (message.type === "VU_OPEN_VULMS") {
    chrome.tabs.create({ url: ORIGIN });
    sendResponse({ ok: true });
    return;
  }
});

ensureAlarms();
