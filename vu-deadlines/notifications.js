/**
 * Chrome notifications for upcoming VULMS deadlines.
 * 72h / 24h / 2h, once each. No overdue spam. No repeats after SW restart.
 */
(function (root) {
  "use strict";

  var OFFSETS = [
    { key: "2h", ms: 2 * 60 * 60 * 1000, label: "2 hours" },
    { key: "24h", ms: 24 * 60 * 60 * 1000, label: "24 hours" },
    { key: "72h", ms: 72 * 60 * 60 * 1000, label: "72 hours" }
  ];

  function dueDateLabel(iso) {
    try {
      return new Intl.DateTimeFormat("en-PK", {
        timeZone: "Asia/Karachi",
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true
      }).format(new Date(iso));
    } catch (err) {
      return iso;
    }
  }

  function relativePhrase(dueAt, nowMs) {
    var remaining = Date.parse(dueAt) - nowMs;
    var hours = remaining / (60 * 60 * 1000);
    if (hours <= 2.5) {
      return "Due in about 2 hours, at 11:59 PM";
    }
    if (hours <= 26) {
      return "Due tomorrow at 11:59 PM";
    }
    return "Due " + dueDateLabel(dueAt);
  }

  /**
   * Catch-up without spam: only fire the tightest window we are already inside.
   * Larger missed windows are marked notified silently.
   */
  function planReminders(activity, nowMs) {
    var dueMs = Date.parse(activity.dueAt);
    if (!Number.isFinite(dueMs)) {
      return { send: null, notifiedFor: activity.notifiedFor || [] };
    }
    if (nowMs > dueMs) {
      return { send: null, notifiedFor: activity.notifiedFor || [] };
    }
    var remaining = dueMs - nowMs;
    var notified = new Set(activity.notifiedFor || []);
    var applicable = OFFSETS.filter(function (offset) {
      return remaining <= offset.ms;
    });
    if (!applicable.length) {
      return { send: null, notifiedFor: Array.from(notified) };
    }
    var tightest = applicable[0];
    applicable.forEach(function (offset) {
      if (offset.key !== tightest.key) {
        notified.add(offset.key);
      }
    });
    var send = null;
    if (!notified.has(tightest.key)) {
      send = tightest.key;
      notified.add(tightest.key);
    }
    return { send: send, notifiedFor: Array.from(notified) };
  }

  async function showReminder(activity, key) {
    if (!chrome.notifications || !chrome.notifications.create) {
      return;
    }
    var title = activity.courseCode + " — " + activity.title;
    var message = relativePhrase(activity.dueAt, Date.now());
    await chrome.notifications.create("vu|" + activity.id, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: title,
      message: message,
      contextMessage: activity.courseName || activity.semester || "VU Buddy",
      priority: key === "2h" ? 2 : 1
    });
  }

  async function checkNotifications(state) {
    if (!state || !Array.isArray(state.activities)) {
      return { state: state, changed: false };
    }
    var nowMs = Date.now();
    var changed = false;
    var nextActivities = [];
    for (var i = 0; i < state.activities.length; i += 1) {
      var activity = state.activities[i];
      var plan = planReminders(activity, nowMs);
      var next = Object.assign({}, activity, { notifiedFor: plan.notifiedFor });
      if (JSON.stringify(plan.notifiedFor.slice().sort()) !== JSON.stringify((activity.notifiedFor || []).slice().sort())) {
        changed = true;
      }
      if (plan.send) {
        try {
          await showReminder(activity, plan.send);
        } catch (err) {
          next.notifiedFor = activity.notifiedFor || [];
        }
      }
      nextActivities.push(next);
    }
    if (!changed) {
      return { state: state, changed: false };
    }
    state.activities = nextActivities;
    return { state: state, changed: true };
  }

  async function openActivityFromNotification(notificationId) {
    if (!notificationId || notificationId.indexOf("vu|") !== 0) {
      return;
    }
    var activityId = notificationId.slice(3);
    var state = await VuStorage.loadState();
    var activity = (state.activities || []).find(function (item) {
      return item.id === activityId;
    });
    var url = activity && activity.sourceUrl
      ? activity.sourceUrl
      : "https://vulms.vu.edu.pk/ActivityCalendar/ActivityCalendar.aspx";
    if (url.indexOf("https://vulms.vu.edu.pk/") !== 0) {
      url = "https://vulms.vu.edu.pk/ActivityCalendar/ActivityCalendar.aspx";
    }
    await chrome.tabs.create({ url: url });
  }

  var api = {
    OFFSETS: OFFSETS,
    planReminders: planReminders,
    checkNotifications: checkNotifications,
    openActivityFromNotification: openActivityFromNotification
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.VuNotifications = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
