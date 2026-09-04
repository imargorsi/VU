/**
 * Optional Todoist adapter.
 * Isolated from VULMS parsing. Tokens never leave the service-worker context.
 */
(function (root) {
  "use strict";

  var AUTH_KEY = "vuTodoistAuth";
  var STATE_KEY = "vuTodoistState";
  var CLIENT_KEY = "vuTodoistClient";

  var REGISTER_URL = "https://api.todoist.com/oauth/register";
  var AUTHORIZE_URL = "https://app.todoist.com/oauth/authorize";
  var TOKEN_URL = "https://api.todoist.com/oauth/access_token";
  var API_ORIGIN = "https://api.todoist.com";
  var SCOPE = "data:read_write";
  var DEFAULT_PROJECT_NAME = "VU University";
  var TODOIST_ORIGINS = ["https://api.todoist.com/*", "https://app.todoist.com/*"];

  function emptyPublicState() {
    return {
      connected: false,
      status: "disconnected",
      error: null,
      projectId: null,
      projectName: null,
      projects: [],
      autoSync: true,
      lastSync: null,
      todoistTaskIdByActivityId: {},
      fingerprints: {},
      stats: { total: 0, synced: 0, pending: 0 }
    };
  }

  function normalizePublicState(raw) {
    var state = emptyPublicState();
    if (!raw || typeof raw !== "object") {
      return state;
    }
    state.connected = Boolean(raw.connected);
    state.status = raw.status || (state.connected ? "connected" : "disconnected");
    state.error = raw.error || null;
    state.projectId = raw.projectId || null;
    state.projectName = raw.projectName || null;
    state.projects = Array.isArray(raw.projects) ? raw.projects : [];
    state.autoSync = raw.autoSync !== false;
    state.lastSync = raw.lastSync || null;
    state.todoistTaskIdByActivityId =
      raw.todoistTaskIdByActivityId && typeof raw.todoistTaskIdByActivityId === "object"
        ? raw.todoistTaskIdByActivityId
        : {};
    state.fingerprints =
      raw.fingerprints && typeof raw.fingerprints === "object" ? raw.fingerprints : {};
    if (raw.stats && typeof raw.stats === "object") {
      state.stats = {
        total: Number(raw.stats.total) || 0,
        synced: Number(raw.stats.synced) || 0,
        pending: Number(raw.stats.pending) || 0
      };
    }
    return state;
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

  function isSyncable(activity) {
    if (!activity || !activity.id) {
      return false;
    }
    if (activity.type === "challan") {
      return false;
    }
    return Boolean(activity.courseCode && activity.title && activity.dueAt);
  }

  function taskContent(activity) {
    return String(activity.courseCode) + " — " + String(activity.title);
  }

  function taskDescription(activity) {
    var lines = [
      "Course: " + (activity.courseName || activity.courseCode),
      "Course Code: " + activity.courseCode,
      "Type: " + typeLabel(activity.type),
      "Semester: " + (activity.semester || "")
    ];
    lines.push("");
    lines.push("Source: VULMS");
    if (activity.sourceUrl) {
      lines.push(String(activity.sourceUrl));
    }
    return lines.join("\n");
  }

  function fingerprint(activity) {
    return [
      activity.id,
      activity.courseCode,
      activity.courseName || "",
      activity.type,
      activity.title,
      activity.dueAt,
      activity.semester || "",
      activity.sourceUrl || ""
    ].join("\u0001");
  }

  function buildTaskPayload(activity, projectId) {
    var payload = {
      content: taskContent(activity),
      description: taskDescription(activity),
      due_datetime: activity.dueAt,
      due_lang: "en"
    };
    if (projectId) {
      payload.project_id = projectId;
    }
    return payload;
  }

  function pickDefaultProject(projects) {
    var list = projects || [];
    var i;
    var preferred = /^(vu university|university|vu)$/i;
    for (i = 0; i < list.length; i += 1) {
      if (preferred.test(String(list[i].name || "").trim())) {
        return list[i];
      }
    }
    return null;
  }

  function makeError(message, code, status) {
    var err = new Error(message);
    err.code = code;
    err.status = status || 0;
    return err;
  }

  function classifyApiError(status, bodyText) {
    if (status === 401 || status === 403) {
      return makeError("Todoist connection expired.", "auth", status);
    }
    if (status === 404) {
      return makeError("Todoist task not found.", "not_found", status);
    }
    return makeError(bodyText || "Todoist API unavailable.", "unavailable", status);
  }

  /**
   * Pure sync algorithm. `api` must provide createTask(payload) and updateTask(id, payload).
   * Never deletes Todoist tasks. Never mutates VULMS activities.
   */
  async function syncActivities(activities, snapshot, api) {
    var mapping = Object.assign({}, (snapshot && snapshot.todoistTaskIdByActivityId) || {});
    var fingerprints = Object.assign({}, (snapshot && snapshot.fingerprints) || {});
    var projectId = snapshot && snapshot.projectId;
    var list = Array.isArray(activities) ? activities : [];
    var created = 0;
    var updated = 0;
    var skipped = 0;
    var failed = 0;
    var authExpired = false;
    var error = null;
    var i;

    if (!projectId) {
      return {
        mapping: mapping,
        fingerprints: fingerprints,
        created: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
        authExpired: false,
        error: "Select a Todoist project first.",
        stats: statsFor(list, mapping)
      };
    }

    for (i = 0; i < list.length; i += 1) {
      var activity = list[i];
      if (!isSyncable(activity)) {
        continue;
      }
      var print = fingerprint(activity);
      var existingId = mapping[activity.id];
      if (existingId && fingerprints[activity.id] === print) {
        skipped += 1;
        continue;
      }
      var payload = buildTaskPayload(activity, projectId);
      try {
        if (existingId) {
          try {
            await api.updateTask(existingId, payload);
            fingerprints[activity.id] = print;
            updated += 1;
          } catch (updateErr) {
            if (updateErr && updateErr.code === "not_found") {
              var replacement = await api.createTask(payload);
              mapping[activity.id] = String(replacement.id);
              fingerprints[activity.id] = print;
              created += 1;
            } else {
              throw updateErr;
            }
          }
        } else {
          var createdTask = await api.createTask(payload);
          mapping[activity.id] = String(createdTask.id);
          fingerprints[activity.id] = print;
          created += 1;
        }
      } catch (err) {
        failed += 1;
        error = err && err.message ? err.message : "Todoist sync failed.";
        if (err && err.code === "auth") {
          authExpired = true;
          break;
        }
        if (err && err.code === "unavailable") {
          break;
        }
      }
    }

    return {
      mapping: mapping,
      fingerprints: fingerprints,
      created: created,
      updated: updated,
      skipped: skipped,
      failed: failed,
      authExpired: authExpired,
      error: error,
      stats: statsFor(list, mapping)
    };
  }

  function statsFor(activities, mapping) {
    var total = 0;
    var synced = 0;
    (activities || []).forEach(function (activity) {
      if (!isSyncable(activity)) {
        return;
      }
      total += 1;
      if (mapping && mapping[activity.id]) {
        synced += 1;
      }
    });
    return { total: total, synced: synced, pending: Math.max(0, total - synced) };
  }

  async function loadAuth() {
    var data = await chrome.storage.local.get(AUTH_KEY);
    return data[AUTH_KEY] && typeof data[AUTH_KEY] === "object" ? data[AUTH_KEY] : null;
  }

  async function saveAuth(auth) {
    if (!auth) {
      await chrome.storage.local.remove(AUTH_KEY);
      return;
    }
    await chrome.storage.local.set({ [AUTH_KEY]: auth });
  }

  async function loadPublicState() {
    var data = await chrome.storage.local.get(STATE_KEY);
    return normalizePublicState(data[STATE_KEY]);
  }

  async function savePublicState(state) {
    await chrome.storage.local.set({ [STATE_KEY]: normalizePublicState(state) });
  }

  async function getPublicState() {
    var state = await loadPublicState();
    var auth = await loadAuth();
    if (!auth || !auth.accessToken) {
      state.connected = false;
      if (state.status !== "failed") {
        state.status = "disconnected";
      }
    } else {
      state.connected = true;
    }
    try {
      if (typeof VuStorage !== "undefined" && VuStorage.loadState) {
        var vulms = await VuStorage.loadState();
        state.stats = statsFor(vulms.activities || [], state.todoistTaskIdByActivityId);
      }
    } catch (err) {
      /* Popup can still render without live stats. */
    }
    return state;
  }

  function randomVerifier() {
    var bytes = crypto.getRandomValues(new Uint8Array(32));
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    var out = "";
    var i;
    for (i = 0; i < bytes.length; i += 1) {
      out += chars.charAt(bytes[i] % chars.length);
    }
    return out + out.slice(0, 11);
  }

  async function challengeS256(verifier) {
    var digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    var bytes = new Uint8Array(digest);
    var binary = "";
    var i;
    for (i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function formBody(fields) {
    return Object.keys(fields)
      .filter(function (key) {
        return fields[key] != null && fields[key] !== "";
      })
      .map(function (key) {
        return encodeURIComponent(key) + "=" + encodeURIComponent(fields[key]);
      })
      .join("&");
  }

  function launchWebAuthFlow(url) {
    return new Promise(function (resolve, reject) {
      chrome.identity.launchWebAuthFlow({ url: url, interactive: true }, function (redirectUrl) {
        if (chrome.runtime.lastError || !redirectUrl) {
          reject(new Error(chrome.runtime.lastError ? chrome.runtime.lastError.message : "Todoist authorization was cancelled."));
          return;
        }
        resolve(redirectUrl);
      });
    });
  }

  async function ensurePublicClient(redirectUri) {
    var data = await chrome.storage.local.get(CLIENT_KEY);
    var stored = data[CLIENT_KEY];
    if (stored && stored.clientId && stored.redirectUri === redirectUri) {
      return stored.clientId;
    }
    var response = await fetch(REGISTER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "VU Buddy",
        redirect_uris: [redirectUri],
        scope: SCOPE,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none"
      })
    });
    var body = await response.json().catch(function () {
      return {};
    });
    if (!response.ok || !body.client_id) {
      throw new Error(body.error || "Could not register a Todoist OAuth client.");
    }
    await chrome.storage.local.set({
      [CLIENT_KEY]: { clientId: body.client_id, redirectUri: redirectUri }
    });
    return body.client_id;
  }

  async function exchangeToken(fields) {
    var response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody(fields)
    });
    var body = await response.json().catch(function () {
      return {};
    });
    if (!response.ok || !body.access_token) {
      throw makeError(body.error || "Todoist token exchange failed.", "auth", response.status);
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token || null,
      tokenType: body.token_type || "Bearer",
      scope: body.scope || SCOPE,
      expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000
    };
  }

  async function persistTokens(partial) {
    var client = (await chrome.storage.local.get(CLIENT_KEY))[CLIENT_KEY] || {};
    var previous = (await loadAuth()) || {};
    await saveAuth({
      clientId: client.clientId || previous.clientId,
      accessToken: partial.accessToken,
      refreshToken: partial.refreshToken || previous.refreshToken || null,
      tokenType: partial.tokenType || "Bearer",
      scope: partial.scope || SCOPE,
      expiresAt: partial.expiresAt
    });
  }

  async function refreshAccessToken() {
    var auth = await loadAuth();
    var client = (await chrome.storage.local.get(CLIENT_KEY))[CLIENT_KEY] || {};
    if (!auth || !auth.refreshToken || !client.clientId) {
      throw makeError("Todoist connection expired.", "auth", 401);
    }
    var tokens = await exchangeToken({
      client_id: client.clientId,
      grant_type: "refresh_token",
      refresh_token: auth.refreshToken
    });
    if (!tokens.refreshToken) {
      tokens.refreshToken = auth.refreshToken;
    }
    await persistTokens(tokens);
    return tokens.accessToken;
  }

  async function getValidAccessToken() {
    var auth = await loadAuth();
    if (!auth || !auth.accessToken) {
      throw makeError("Todoist is not connected.", "auth", 401);
    }
    if (auth.expiresAt && Date.now() > auth.expiresAt - 60000) {
      if (auth.refreshToken) {
        return refreshAccessToken();
      }
    }
    return auth.accessToken;
  }

  async function todoistFetch(method, path, jsonBody, didRefresh) {
    var token = await getValidAccessToken();
    var response = await fetch(API_ORIGIN + path, {
      method: method,
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: jsonBody ? JSON.stringify(jsonBody) : undefined
    });
    if (response.status === 401 && !didRefresh) {
      try {
        await refreshAccessToken();
        return todoistFetch(method, path, jsonBody, true);
      } catch (err) {
        throw makeError("Todoist connection expired.", "auth", 401);
      }
    }
    if (response.status === 204) {
      return null;
    }
    var text = await response.text();
    var body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch (err) {
        body = { error: text };
      }
    }
    if (!response.ok) {
      throw classifyApiError(response.status, body && (body.error || body.message));
    }
    return body;
  }

  var liveApi = {
    getProjects: async function () {
      var all = [];
      var cursor = null;
      do {
        var path = "/api/v1/projects?limit=200" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
        var data = await todoistFetch("GET", path);
        var page = Array.isArray(data) ? data : data && data.results ? data.results : [];
        all = all.concat(page);
        cursor = data && (data.next_cursor || data.nextCursor) ? data.next_cursor || data.nextCursor : null;
      } while (cursor);
      return all.map(function (project) {
        return { id: String(project.id), name: project.name || "Untitled" };
      });
    },
    createProject: async function (name) {
      var project = await todoistFetch("POST", "/api/v1/projects", { name: name });
      return { id: String(project.id), name: project.name || name };
    },
    createTask: async function (payload) {
      var task = await todoistFetch("POST", "/api/v1/tasks", payload);
      return { id: String(task.id) };
    },
    updateTask: async function (id, payload) {
      return todoistFetch("POST", "/api/v1/tasks/" + encodeURIComponent(id), payload);
    },
    getTask: async function (id) {
      return todoistFetch("GET", "/api/v1/tasks/" + encodeURIComponent(id));
    }
  };

  async function markExpired(message) {
    var state = await loadPublicState();
    state.status = "expired";
    state.error = message || "Todoist connection expired.";
    state.connected = true;
    await savePublicState(state);
    return state;
  }

  async function markFailed(message) {
    var state = await loadPublicState();
    state.status = "failed";
    state.error = message || "Todoist sync failed.";
    await savePublicState(state);
    return state;
  }

  async function refreshProjectsInto(state) {
    var projects = await liveApi.getProjects();
    state.projects = projects;
    if (state.projectId) {
      var stillThere = projects.some(function (project) {
        return project.id === state.projectId;
      });
      if (!stillThere) {
        state.projectId = null;
        state.projectName = null;
      }
    }
    if (!state.projectId) {
      var fallback = pickDefaultProject(projects);
      if (fallback) {
        state.projectId = fallback.id;
        state.projectName = fallback.name;
      }
    }
    return state;
  }

  async function connect() {
    try {
      var redirectUri = chrome.identity.getRedirectURL();
      var clientId = await ensurePublicClient(redirectUri);
    var verifier = randomVerifier();
    var challenge = await challengeS256(verifier);
    var stateToken = randomVerifier().slice(0, 24);
    var url =
      AUTHORIZE_URL +
      "?client_id=" +
      encodeURIComponent(clientId) +
      "&scope=" +
      encodeURIComponent(SCOPE) +
      "&state=" +
      encodeURIComponent(stateToken) +
      "&response_type=code" +
      "&redirect_uri=" +
      encodeURIComponent(redirectUri) +
      "&code_challenge=" +
      encodeURIComponent(challenge) +
      "&code_challenge_method=S256";
    var redirectUrl = await launchWebAuthFlow(url);
    var parsed = new URL(redirectUrl);
    if (parsed.searchParams.get("error")) {
      throw new Error("Todoist authorization was denied.");
    }
    if (parsed.searchParams.get("state") !== stateToken) {
      throw new Error("Todoist authorization state mismatch.");
    }
    var code = parsed.searchParams.get("code");
    if (!code) {
      throw new Error("Todoist did not return an authorization code.");
    }
    var tokens = await exchangeToken({
      client_id: clientId,
      grant_type: "authorization_code",
      code: code,
      redirect_uri: redirectUri,
      code_verifier: verifier
    });
    await persistTokens(tokens);
    var publicState = await loadPublicState();
    publicState.connected = true;
    publicState.status = "connected";
    publicState.error = null;
    publicState.autoSync = publicState.autoSync !== false;
    publicState = await refreshProjectsInto(publicState);
    await savePublicState(publicState);
    return publicState;
    } catch (err) {
      var failed = await loadPublicState();
      failed.status = "failed";
      failed.error = err && err.message ? err.message : "Todoist connection failed.";
      await savePublicState(failed);
      throw err;
    }
  }

  async function disconnect() {
    await saveAuth(null);
    var state = await loadPublicState();
    state.connected = false;
    state.status = "disconnected";
    state.error = null;
    state.lastSync = null;
    await savePublicState(state);
    return state;
  }

  async function setProject(projectId) {
    var state = await loadPublicState();
    var match = (state.projects || []).find(function (project) {
      return project.id === projectId;
    });
    state.projectId = projectId || null;
    state.projectName = match ? match.name : null;
    await savePublicState(state);
    return state;
  }

  async function setAutoSync(enabled) {
    var state = await loadPublicState();
    state.autoSync = Boolean(enabled);
    await savePublicState(state);
    return state;
  }

  async function createUniversityProject() {
    try {
      var created = await liveApi.createProject(DEFAULT_PROJECT_NAME);
      var state = await loadPublicState();
      var exists = (state.projects || []).some(function (project) {
        return project.id === created.id;
      });
      if (!exists) {
        state.projects = (state.projects || []).concat([created]);
      }
      state.projectId = created.id;
      state.projectName = created.name;
      state.status = "connected";
      state.error = null;
      await savePublicState(state);
      return state;
    } catch (err) {
      if (err && err.code === "auth") {
        return markExpired(err.message);
      }
      return markFailed(err && err.message ? err.message : "Could not create Todoist project.");
    }
  }

  var syncing = false;

  async function runSync(activities) {
    if (syncing) {
      return getPublicState();
    }
    syncing = true;
    var state = await loadPublicState();
    try {
      var auth = await loadAuth();
      if (!auth || !auth.accessToken) {
        state.connected = false;
        state.status = "disconnected";
        await savePublicState(state);
        return state;
      }
      state.status = "syncing";
      state.error = null;
      await savePublicState(state);
      var result = await syncActivities(activities, state, liveApi);
      state.todoistTaskIdByActivityId = result.mapping;
      state.fingerprints = result.fingerprints;
      state.stats = result.stats;
      if (result.authExpired) {
        state.status = "expired";
        state.error = result.error || "Todoist connection expired.";
        state.connected = true;
        await savePublicState(state);
        return state;
      }
      if (result.error && result.failed > 0 && result.created === 0 && result.updated === 0) {
        state.status = "failed";
        state.error = result.error;
        await savePublicState(state);
        return state;
      }
      state.status = result.error ? "failed" : "connected";
      state.error = result.error;
      state.lastSync = new Date().toISOString();
      state.connected = true;
      await savePublicState(state);
      return state;
    } catch (err) {
      if (err && err.code === "auth") {
        return markExpired(err.message);
      }
      return markFailed(err && err.message ? err.message : "Todoist sync failed.");
    } finally {
      syncing = false;
    }
  }

  async function maybeAutoSyncAfterVulms() {
    var state = await loadPublicState();
    var auth = await loadAuth();
    if (!auth || !auth.accessToken || !state.autoSync || !state.projectId) {
      return state;
    }
    if (state.status === "expired") {
      return state;
    }
    var vulms = await VuStorage.loadState();
    return runSync(vulms.activities || []);
  }

  async function syncNow() {
    var vulms = await VuStorage.loadState();
    return runSync(vulms.activities || []);
  }

  var api = {
    AUTH_KEY: AUTH_KEY,
    STATE_KEY: STATE_KEY,
    TODOIST_ORIGINS: TODOIST_ORIGINS,
    DEFAULT_PROJECT_NAME: DEFAULT_PROJECT_NAME,
    isSyncable: isSyncable,
    taskContent: taskContent,
    taskDescription: taskDescription,
    fingerprint: fingerprint,
    buildTaskPayload: buildTaskPayload,
    pickDefaultProject: pickDefaultProject,
    syncActivities: syncActivities,
    statsFor: statsFor,
    getPublicState: getPublicState,
    connect: connect,
    disconnect: disconnect,
    setProject: setProject,
    setAutoSync: setAutoSync,
    createUniversityProject: createUniversityProject,
    maybeAutoSyncAfterVulms: maybeAutoSyncAfterVulms,
    syncNow: syncNow,
    refreshProjectsInto: refreshProjectsInto
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.VuTodoist = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
