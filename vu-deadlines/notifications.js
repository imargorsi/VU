/**
 * Chrome notifications for upcoming VULMS deadlines.
 * Per-activity 72h / 24h / 2h, plus one daily digest.
 * No overdue spam. No repeats after SW restart.
 */
(function (root) {
  "use strict";

  var OFFSETS = [
    { key: "2h", ms: 2 * 60 * 60 * 1000, label: "2 hours" },
    { key: "24h", ms: 24 * 60 * 60 * 1000, label: "24 hours" },
    { key: "72h", ms: 72 * 60 * 60 * 1000, label: "72 hours" }
  ];
  var DIGEST_ID = "digest";
  var DIGEST_AFTER_HOUR = 8;
  var DIGEST_DAYS = 7;
  var CALENDAR_URL = "https://vulms.vu.edu.pk/ActivityCalendar/ActivityCalendar.aspx";

  function canNotify() {
    return typeof chrome !== "undefined" && chrome.notifications && chrome.notifications.create;
  }

  function karachiClock(date) {
    var parts = {};
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Karachi",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date).forEach(function (part) {
      parts[part.type] = part.value;
    });
    return {
      ymd: parts.year + "-" + parts.month + "-" + parts.day,
      hour: Number(parts.hour)
    };
  }

  function ymdToUtc(ymd) {
    return Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));
  }

  function daysUntilDue(activity, now) {
    var dueDay = karachiClock(new Date(activity.dueAt)).ymd;
    var today = karachiClock(now).ymd;
    return Math.round((ymdToUtc(dueDay) - ymdToUtc(today)) / 86400000);
  }

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

  function digestRelative(days) {
    if (days <= 0) {
      return "today";
    }
    if (days === 1) {
      return "tomorrow";
    }
    return "in " + days + " days";
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

  /**
   * One Chrome notification per Karachi calendar day, after 08:00.
   * Counts deadlines due today through the next 6 days. Overdue items are omitted.
   */
  function planDigest(state, now) {
    var clock = karachiClock(now);
    var empty = {
      send: false,
      lastDigestYmd: state && state.lastDigestYmd ? state.lastDigestYmd : null,
      message: null
    };
    if (!state || !Array.isArray(state.activities) || !state.activities.length) {
      return empty;
    }
    if (clock.hour < DIGEST_AFTER_HOUR) {
      return empty;
    }
    if (state.lastDigestYmd === clock.ymd) {
      return empty;
    }
    var upcoming = state.activities.filter(function (item) {
      if (!item || !item.dueAt) {
        return false;
      }
      var days = daysUntilDue(item, now);
      return days >= 0 && days < DIGEST_DAYS;
    }).sort(function (a, b) {
      return Date.parse(a.dueAt) - Date.parse(b.dueAt);
    });
    if (!upcoming.length) {
      return empty;
    }
    var soonest = upcoming[0];
    var highlight =
      String(soonest.courseCode || "") +
      " " +
      String(soonest.title || "").trim();
    var message =
      upcoming.length +
      " due this week — " +
      highlight.trim() +
      " " +
      digestRelative(daysUntilDue(soonest, now));
    return {
      send: true,
      lastDigestYmd: clock.ymd,
      message: message
    };
  }

  async function showReminder(activity, key) {
    if (!canNotify()) {
      return;
    }
    var title = activity.courseCode + " — " + activity.title;
    var message = relativePhrase(activity.dueAt, Date.now());
    await chrome.notifications.create("vu|" + activity.id, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: title,
      message: message,
      contextMessage: activity.courseName || activity.semester || "VU Deadlines",
      priority: key === "2h" ? 2 : 1
    });
  }

  async function showDigest(digest) {
    if (!canNotify() || !digest || !digest.message) {
      return;
    }
    await chrome.notifications.create("vu|" + DIGEST_ID, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "VU Deadlines",
      message: digest.message,
      contextMessage: "Open VULMS calendar",
      priority: 1
    });
  }

  async function checkNotifications(state) {
    if (!state || !Array.isArray(state.activities)) {
      return { state: state, changed: false };
    }
    var nowMs = Date.now();
    var now = new Date(nowMs);
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
    if (changed) {
      state.activities = nextActivities;
    }
    var digest = planDigest(state, now);
    if (digest.send) {
      try {
        await showDigest(digest);
        state.lastDigestYmd = digest.lastDigestYmd;
        changed = true;
      } catch (err) {
        /* Keep lastDigestYmd unset so the next alarm can retry. */
      }
    }
    return { state: state, changed: changed };
  }

  async function openActivityFromNotification(notificationId) {
    if (!notificationId || notificationId.indexOf("vu|") !== 0) {
      return;
    }
    var activityId = notificationId.slice(3);
    var url = CALENDAR_URL;
    if (activityId !== DIGEST_ID) {
      var state = await VuStorage.loadState();
      var activity = (state.activities || []).find(function (item) {
        return item.id === activityId;
      });
      if (activity && activity.sourceUrl) {
        url = activity.sourceUrl;
      }
    }
    if (url.indexOf("https://vulms.vu.edu.pk/") !== 0) {
      url = CALENDAR_URL;
    }
    await chrome.tabs.create({ url: url });
  }

  var api = {
    OFFSETS: OFFSETS,
    DIGEST_ID: DIGEST_ID,
    planReminders: planReminders,
    planDigest: planDigest,
    checkNotifications: checkNotifications,
    openActivityFromNotification: openActivityFromNotification
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.VuNotifications = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
