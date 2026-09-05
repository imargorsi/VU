/**
 * chrome.storage.local wrapper. Academic deadline cache only.
 * Never stores passwords, usernames, roll numbers, cookies, or tokens.
 */
(function (root) {
  "use strict";

  var STORAGE_KEY = "vuDeadlinesState";

  var DEFAULT_STATE = {
    activities: [],
    courseMap: {},
    lastSuccessfulSync: null,
    lastSyncAttempt: null,
    syncStatus: "never",
    syncError: null,
    fetchPath: null,
    sessionDiagnostic: null,
    lastDigestYmd: null
  };

  function cloneDefault() {
    return {
      activities: [],
      courseMap: {},
      lastSuccessfulSync: null,
      lastSyncAttempt: null,
      syncStatus: "never",
      syncError: null,
      fetchPath: null,
      sessionDiagnostic: null,
      lastDigestYmd: null
    };
  }

  function normalizeState(raw) {
    var state = cloneDefault();
    if (!raw || typeof raw !== "object") {
      return state;
    }
    if (Array.isArray(raw.activities)) {
      state.activities = raw.activities;
    }
    if (raw.courseMap && typeof raw.courseMap === "object") {
      state.courseMap = raw.courseMap;
    }
    state.lastSuccessfulSync = raw.lastSuccessfulSync || null;
    state.lastSyncAttempt = raw.lastSyncAttempt || null;
    state.syncStatus = raw.syncStatus || "never";
    state.syncError = raw.syncError || null;
    state.fetchPath = raw.fetchPath || null;
    state.sessionDiagnostic = raw.sessionDiagnostic || null;
    state.lastDigestYmd = typeof raw.lastDigestYmd === "string" ? raw.lastDigestYmd : null;
    return state;
  }

  async function loadState() {
    var data = await chrome.storage.local.get(STORAGE_KEY);
    return normalizeState(data[STORAGE_KEY]);
  }

  async function saveState(state) {
    await chrome.storage.local.set({ [STORAGE_KEY]: normalizeState(state) });
  }

  /**
   * Upsert by stable id. Preserves firstSeenAt and notifiedFor.
   * If the due date moved later, reminder flags are cleared.
   */
  function mergeActivities(previous, incoming) {
    var byId = new Map();
    (previous || []).forEach(function (item) {
      if (item && item.id) {
        byId.set(item.id, item);
      }
    });
    return (incoming || []).map(function (next) {
      var prev = byId.get(next.id);
      if (!prev) {
        return next;
      }
      var dueMovedLater = Boolean(prev.dueAt && next.dueAt && next.dueAt > prev.dueAt);
      return Object.assign({}, next, {
        firstSeenAt: prev.firstSeenAt || next.firstSeenAt,
        notifiedFor: dueMovedLater ? [] : Array.isArray(prev.notifiedFor) ? prev.notifiedFor.slice() : []
      });
    });
  }

  var api = {
    STORAGE_KEY: STORAGE_KEY,
    DEFAULT_STATE: DEFAULT_STATE,
    loadState: loadState,
    saveState: saveState,
    mergeActivities: mergeActivities,
    normalizeState: normalizeState
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.VuStorage = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
