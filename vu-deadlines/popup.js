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
  if (codes.length < 2) {
    wrap.hidden = true;
    courseFilter = "all";
    return;
  }
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
          '<div class="pill">' + escapeHtml(typeLabel(item.type)) + "</div>" +
        "</div>" +
        courseName +
        '<p class="activity-title">' + escapeHtml(item.title) + "</p>" +
        '<p class="relative">' + escapeHtml(relativeLabel(item, now)) + "</p>" +
        '<div class="meta">' +
          '<span class="pill">' + escapeHtml(formatDue(item.dueAt)) + "</span>" +
          '<span class="pill">' + escapeHtml(formatTime(item.dueAt)) + "</span>" +
          marks +
        "</div>" +
      "</article>"
    );
  }).join("");
}

function todoistAgo(iso) {
  if (!iso) {
    return "Never";
  }
  return syncedLabel(iso).replace(/^Last synced: /, "");
}

function runtimeSend(payload, callback) {
  chrome.runtime.sendMessage(payload, function (response) {
    void chrome.runtime.lastError;
    if (callback) {
      callback(response);
    }
  });
}

function sendTodoist(type, extra, button) {
  if (button) {
    button.disabled = true;
  }
  runtimeSend(Object.assign({ type: type }, extra || {}), function (state) {
    if (button) {
      button.disabled = false;
    }
    render(state || currentState);
  });
}

function requestTodoistAccess(onGranted) {
  chrome.permissions.request(
    {
      permissions: ["identity"],
      origins: ["https://api.todoist.com/*", "https://app.todoist.com/*"]
    },
    function (granted) {
      if (!granted) {
        return;
      }
      onGranted();
    }
  );
}

function renderTodoist(todoist) {
  var root = $("todoist-panel");
  var footer = $("privacy-footer");
  var data = todoist || {};
  var connected = Boolean(data.connected);
  var expired = data.status === "expired";
  var failed = data.status === "failed";
  var statusHtml;
  var body;
  footer.textContent = connected
    ? "Unofficial. Selected VULMS deadlines are sent to Todoist when sync is enabled."
    : "Unofficial. Without Todoist, your VULMS data stays in this browser.";

  if (expired) {
    statusHtml = '<span class="todoist-status is-warn">⚠ Connection expired</span>';
    body =
      '<p class="todoist-copy">Todoist connection expired. Your VULMS deadlines are still stored locally.</p>' +
      '<div class="todoist-actions"><button id="todoist-connect" type="button">Reconnect</button></div>';
  } else if (failed) {
    statusHtml = '<span class="todoist-status is-warn">⚠ Sync failed</span>';
    body =
      '<p class="todoist-copy">Your VULMS deadlines are still safely stored locally.' +
      (data.error ? " " + escapeHtml(data.error) : "") +
      "</p>" +
      '<div class="todoist-actions">' +
        (connected
          ? '<button id="todoist-retry" type="button">Retry</button>' +
            '<button class="ghost-btn" id="todoist-disconnect" type="button">Disconnect Todoist</button>'
          : '<button id="todoist-connect" type="button">Connect Todoist</button>') +
      "</div>" +
      (connected
        ? '<div id="todoist-confirm" class="confirm-box" hidden>Disconnect Todoist? Your existing Todoist tasks will NOT be deleted. ' +
          '<button class="ghost-btn" id="todoist-cancel" type="button">Cancel</button> ' +
          '<button id="todoist-confirm-yes" type="button">Disconnect</button></div>'
        : "");
  } else if (!connected || data.status === "disconnected") {
    statusHtml = '<span class="todoist-status is-off">○ Not connected</span>';
    body =
      '<p class="todoist-copy">Sync your VULMS deadlines with Todoist.</p>' +
      '<div class="todoist-actions"><button id="todoist-connect" type="button">Connect Todoist</button></div>';
  } else {
    var projects = data.projects || [];
    var options = '<option value="">Select a project</option>' + projects.map(function (project) {
      var selected = project.id === data.projectId ? " selected" : "";
      return '<option value="' + escapeHtml(project.id) + '"' + selected + ">" + escapeHtml(project.name) + "</option>";
    }).join("");
    var stats = data.stats || { total: 0, synced: 0, pending: 0 };
    statusHtml = '<span class="todoist-status is-on">● Connected</span>';
    body =
      '<div class="todoist-row"><span>Project</span><select id="todoist-project">' + options + "</select></div>" +
      '<p class="todoist-copy">Last synced: ' + escapeHtml(todoistAgo(data.lastSync)) + "</p>" +
      '<label class="auto-sync"><input id="todoist-autosync" type="checkbox"' +
      (data.autoSync !== false ? " checked" : "") +
      "> Automatically sync new/changed deadlines</label>" +
      '<p class="todoist-stats">' + stats.total + " VULMS deadlines · " + stats.synced + " synced · " + stats.pending + " pending</p>" +
      '<div class="todoist-actions">' +
        '<button id="todoist-sync" type="button">Sync to Todoist</button>' +
        '<button class="ghost-btn" id="todoist-create-project" type="button">Create "VU University" project</button>' +
        '<button class="ghost-btn" id="todoist-disconnect" type="button">Disconnect Todoist</button>' +
      "</div>" +
      '<div id="todoist-confirm" class="confirm-box" hidden>Disconnect Todoist? Your existing Todoist tasks will NOT be deleted. ' +
        '<button class="ghost-btn" id="todoist-cancel" type="button">Cancel</button> ' +
        '<button id="todoist-confirm-yes" type="button">Disconnect</button></div>';
  }

  root.innerHTML =
    '<div class="todoist-head"><h2>Todoist</h2>' + statusHtml + "</div>" + body;

  var connectBtn = $("todoist-connect");
  if (connectBtn) {
    connectBtn.addEventListener("click", function () {
      requestTodoistAccess(function () {
        sendTodoist("VU_TODOIST_CONNECT", null, connectBtn);
      });
    });
  }
  var retryBtn = $("todoist-retry");
  if (retryBtn) {
    retryBtn.addEventListener("click", function () {
      sendTodoist("VU_TODOIST_SYNC", null, retryBtn);
    });
  }
  var projectSelect = $("todoist-project");
  if (projectSelect) {
    projectSelect.addEventListener("change", function (event) {
      sendTodoist("VU_TODOIST_SET_PROJECT", { projectId: event.target.value || null });
    });
  }
  var auto = $("todoist-autosync");
  if (auto) {
    auto.addEventListener("change", function (event) {
      sendTodoist("VU_TODOIST_SET_AUTOSYNC", { enabled: event.target.checked });
    });
  }
  var syncBtn = $("todoist-sync");
  if (syncBtn) {
    syncBtn.addEventListener("click", function () {
      sendTodoist("VU_TODOIST_SYNC", null, syncBtn);
    });
  }
  var createBtn = $("todoist-create-project");
  if (createBtn) {
    createBtn.addEventListener("click", function () {
      sendTodoist("VU_TODOIST_CREATE_PROJECT", null, createBtn);
    });
  }
  var disconnectBtn = $("todoist-disconnect");
  if (disconnectBtn) {
    disconnectBtn.addEventListener("click", function () {
      var box = $("todoist-confirm");
      if (box) {
        box.hidden = false;
        return;
      }
      sendTodoist("VU_TODOIST_DISCONNECT");
    });
  }
  var cancelBtn = $("todoist-cancel");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", function () {
      $("todoist-confirm").hidden = true;
    });
  }
  var confirmBtn = $("todoist-confirm-yes");
  if (confirmBtn) {
    confirmBtn.addEventListener("click", function () {
      sendTodoist("VU_TODOIST_DISCONNECT", null, confirmBtn);
    });
  }
}

function render(state) {
  currentState = state || { activities: [], syncStatus: "never", todoist: { connected: false, status: "disconnected" } };
  var now = new Date();
  var meta = syncedLabel(currentState.lastSuccessfulSync);
  if (currentState.syncStatus === "never") {
    meta = "Not synced yet";
  } else if (currentState.fetchPath === "page-context") {
    meta += " · via open VULMS tab";
  }
  $("sync-meta").textContent = meta;
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
      renderTodoist(currentState.todoist || {});
      return;
    }
  }
  renderList(items, now);
  renderTodoist(currentState.todoist || {});
}

function setSyncing(isSyncing) {
  $("sync-btn").disabled = isSyncing;
  $("sync-btn").textContent = isSyncing ? "Syncing…" : "Sync Now";
}

function requestState() {
  runtimeSend({ type: "VU_GET_STATE" }, function (state) {
    render(state || { activities: [], syncStatus: "never" });
  });
}

$("sync-btn").addEventListener("click", function () {
  setSyncing(true);
  runtimeSend({ type: "VU_SYNC_NOW" }, function (state) {
    setSyncing(false);
    render(state || currentState);
  });
});

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
  if (changes.vuDeadlinesState || changes.vuTodoistState) {
    requestState();
  }
});

requestState();
