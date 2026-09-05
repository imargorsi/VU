"use strict";

var typeFilter = "all";
var courseFilter = "all";
var currentState = null;

function $(id) {
  return document.getElementById(id);
}

function karachiYmd(date) {
  var parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  function grab(type) {
    return parts.find(function (part) {
      return part.type === type;
    }).value;
  }
  return grab("year") + "-" + grab("month") + "-" + grab("day");
}

function ymdToUtc(ymd) {
  return Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));
}

function daysUntilDue(activity, now) {
  var dueDay = karachiYmd(new Date(activity.dueAt));
  var today = karachiYmd(now);
  return Math.round((ymdToUtc(dueDay) - ymdToUtc(today)) / 86400000);
}

function statusOf(activity, now) {
  if (now.getTime() > Date.parse(activity.dueAt)) {
    return "overdue";
  }
  var days = daysUntilDue(activity, now);
  if (days === 0) {
    return "due-today";
  }
  if (days <= 3) {
    return "due-soon";
  }
  return "upcoming";
}

function relativeLabel(activity, now) {
  if (statusOf(activity, now) === "overdue") {
    var late = Math.abs(daysUntilDue(activity, now));
    if (late <= 0) {
      return "Overdue";
    }
    if (late === 1) {
      return "Overdue · 1 day";
    }
    return "Overdue · " + late + " days";
  }
  var days = daysUntilDue(activity, now);
  if (days === 0) {
    return "Due today";
  }
  if (days === 1) {
    return "Due tomorrow";
  }
  return "Due in " + days + " days";
}

function formatDue(iso) {
  return new Intl.DateTimeFormat("en-PK", {
    timeZone: "Asia/Karachi",
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(new Date(iso));
}

function formatTime(iso) {
  return new Intl.DateTimeFormat("en-PK", {
    timeZone: "Asia/Karachi",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).format(new Date(iso));
}

function syncedLabel(iso) {
  if (!iso) {
    return "Never synced";
  }
  var mins = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 1) {
    return "Last synced: just now";
  }
  if (mins === 1) {
    return "Last synced: 1 minute ago";
  }
  if (mins < 60) {
    return "Last synced: " + mins + " minutes ago";
  }
  var hours = Math.floor(mins / 60);
  if (hours === 1) {
    return "Last synced: 1 hour ago";
  }
  if (hours < 24) {
    return "Last synced: " + hours + " hours ago";
  }
  var days = Math.floor(hours / 24);
  return days === 1 ? "Last synced: 1 day ago" : "Last synced: " + days + " days ago";
}

function typeLabel(type) {
  if (type === "quiz") {
    return "Quiz";
  }
  if (type === "assignment") {
    return "Assignment";
  }
  if (type === "gdb") {
    return "GDB";
  }
  return "Other";
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function needsSignIn(state) {
  if (!state) {
    return false;
  }
  var message = state.syncError || "";
  return /sign in to VULMS/i.test(message);
}

function sortActivities(items, now) {
  return items.slice().sort(function (a, b) {
    var aOver = statusOf(a, now) === "overdue";
    var bOver = statusOf(b, now) === "overdue";
    if (aOver !== bOver) {
      return aOver ? -1 : 1;
    }
    return Date.parse(a.dueAt) - Date.parse(b.dueAt);
  });
}

function visibleActivities(state, now) {
  var items = sortActivities(state.activities || [], now);
  return items.filter(function (item) {
    if (typeFilter !== "all" && item.type !== typeFilter) {
      return false;
    }
    if (courseFilter !== "all" && item.courseCode !== courseFilter) {
      return false;
    }
    return true;
  });
}

function renderBanner(state) {
  var banner = $("banner");
  banner.hidden = true;
  banner.innerHTML = "";
  if (needsSignIn(state)) {
    banner.hidden = false;
    banner.innerHTML =
      'Please sign in to VULMS to refresh deadlines. <button class="link" id="open-vulms" type="button">Open VULMS</button>';
    $("open-vulms").addEventListener("click", function () {
      runtimeSend({ type: "VU_OPEN_VULMS" });
    });
    return;
  }
  if (state.syncStatus === "stale" && state.syncError) {
    banner.hidden = false;
    banner.textContent = "Showing saved deadlines. " + state.syncError;
  }
}

function renderSummary(items, now) {
  var upcoming = 0;
  var today = 0;
  var overdue = 0;
  items.forEach(function (item) {
    var status = statusOf(item, now);
    if (status === "overdue") {
      overdue += 1;
    } else if (status === "due-today") {
      today += 1;
    } else {
      upcoming += 1;
    }
  });
  $("count-upcoming").textContent = String(upcoming);
  $("count-today").textContent = String(today);
  $("count-overdue").textContent = String(overdue);
}

function renderCourseFilter(state) {
  var wrap = $("course-filter-wrap");
  var select = $("course-filter");
  var codes = [];
  (state.activities || []).forEach(function (item) {
    if (codes.indexOf(item.courseCode) === -1) {
      codes.push(item.courseCode);
    }
  });
  codes.sort();
  wrap.hidden = false;
  var current = courseFilter;
  select.innerHTML = '<option value="all">All courses</option>' + codes.map(function (code) {
    return '<option value="' + escapeHtml(code) + '">' + escapeHtml(code) + "</option>";
  }).join("");
  select.value = codes.indexOf(current) === -1 ? "all" : current;
  courseFilter = select.value;
}

function renderList(items, now) {
  var root = $("list");
  if (!items.length) {
    root.innerHTML =
      '<div class="empty"><strong>No deadlines in this view</strong>Synced academic items will appear here.</div>';
    return;
  }
  root.innerHTML = items.map(function (item) {
    var status = statusOf(item, now);
    var marks = item.totalMarks != null
      ? '<span class="pill">' + escapeHtml(String(item.totalMarks)) + " Marks</span>"
      : "";
    var courseName = item.courseName
      ? '<div class="course-name">' + escapeHtml(item.courseName) + "</div>"
      : "";
    return (
      '<article class="card is-' + status + '">' +
        '<div class="card-top">' +
          '<div class="course-code">' + escapeHtml(item.courseCode) + "</div>" +
          '<div class="pill pill-type">' + escapeHtml(typeLabel(item.type)) + "</div>" +
        "</div>" +
        courseName +
        '<p class="activity-title">' + escapeHtml(item.title) + "</p>" +
        '<p class="relative">' + escapeHtml(relativeLabel(item, now)) + "</p>" +
        '<div class="meta">' +
          '<span class="pill">' +
            '<svg class="meta-icon" viewBox="0 0 24 24" width="12" height="12" fill-rule="evenodd" aria-hidden="true"><path fill="currentColor" d="M19 4h-1V3a1 1 0 1 0-2 0v1H8V3a1 1 0 1 0-2 0v1H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 16H5V10h14v10z"/></svg>' +
            escapeHtml(formatDue(item.dueAt)) +
          "</span>" +
          '<span class="pill">' +
            '<svg class="meta-icon" viewBox="0 0 24 24" width="12" height="12" fill-rule="evenodd" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16z"/><path fill="currentColor" d="M11.25 7h1.5v5.15l4.1 2.45-.75 1.25-4.85-2.9z"/></svg>' +
            escapeHtml(formatTime(item.dueAt)) +
          "</span>" +
          marks +
        "</div>" +
      "</article>"
    );
  }).join("");
}

function runtimeSend(payload, callback) {
  chrome.runtime.sendMessage(payload, function (response) {
    void chrome.runtime.lastError;
    if (callback) {
      callback(response);
    }
  });
}

function render(state) {
  currentState = state || { activities: [], syncStatus: "never" };
  var now = new Date();
  var meta = syncedLabel(currentState.lastSuccessfulSync);
  if (currentState.syncStatus === "never") {
    meta = "Not synced yet";
  } else if (currentState.fetchPath === "page-context") {
    meta += " · via open VULMS tab";
  }
  $("sync-meta-text").textContent = meta;
  $("sync-meta").classList.toggle("is-ok", currentState.syncStatus === "ok");
  $("sync-meta").classList.toggle(
    "is-warn",
    currentState.syncStatus === "stale" || currentState.syncStatus === "error"
  );
  renderBanner(currentState);
  renderCourseFilter(currentState);
  var items = visibleActivities(currentState, now);
  renderSummary(currentState.activities || [], now);
  if (!currentState.activities || !currentState.activities.length) {
    if (needsSignIn(currentState) || currentState.syncStatus === "never") {
      $("list").innerHTML =
        '<div class="empty"><strong>No deadlines yet</strong>Sign in to VULMS, then tap Sync Now.</div>';
      $("count-upcoming").textContent = "0";
      $("count-today").textContent = "0";
      $("count-overdue").textContent = "0";
      return;
    }
  }
  renderList(items, now);
}

function setSyncing(isSyncing) {
  $("sync-btn").disabled = isSyncing;
  $("sync-btn").textContent = isSyncing ? "Syncing…" : "Sync Now";
  var refresh = $("refresh-btn");
  if (refresh) {
    refresh.disabled = isSyncing;
    refresh.classList.toggle("is-spinning", isSyncing);
  }
}

function startSync() {
  setSyncing(true);
  runtimeSend({ type: "VU_SYNC_NOW" }, function (state) {
    setSyncing(false);
    render(state || currentState);
  });
}

function requestState() {
  runtimeSend({ type: "VU_GET_STATE" }, function (state) {
    render(state || { activities: [], syncStatus: "never" });
  });
}

$("sync-btn").addEventListener("click", startSync);
$("refresh-btn").addEventListener("click", startSync);

document.querySelectorAll(".chip").forEach(function (chip) {
  chip.addEventListener("click", function () {
    typeFilter = chip.getAttribute("data-filter");
    document.querySelectorAll(".chip").forEach(function (node) {
      node.classList.toggle("is-active", node === chip);
    });
    if (currentState) {
      render(currentState);
    }
  });
});

$("course-filter").addEventListener("change", function (event) {
  courseFilter = event.target.value;
  if (currentState) {
    render(currentState);
  }
});

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== "local") {
    return;
  }
  if (changes.vuDeadlinesState) {
    requestState();
  }
});

requestState();
