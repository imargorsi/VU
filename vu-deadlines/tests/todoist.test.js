"use strict";

var assert = require("assert");
var path = require("path");
var todoist = require(path.join(__dirname, "..", "todoist.js"));

var passed = 0;
var failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(function () {
      passed += 1;
      console.log("ok  - " + name);
    })
    .catch(function (err) {
      failed += 1;
      console.error("fail - " + name);
      console.error("     " + (err && err.stack ? err.stack : err));
    });
}

function sampleActivity(overrides) {
  return Object.assign(
    {
      id: "summer-2026:mth301:quiz:1",
      courseCode: "MTH301",
      courseName: "Calculus II",
      type: "quiz",
      title: "Quiz-01",
      dueAt: "2026-09-06T23:59:00+05:00",
      semester: "Summer 2026",
      sourceUrl: "https://vulms.vu.edu.pk/ActivityCalendar/OpenActivitySection.aspx?coursecode=MTH301&ActivityType=QuizList"
    },
    overrides || {}
  );
}

function fakeApi() {
  var tasks = {};
  var nextId = 1000;
  var mode = null;
  var createCount = 0;
  var updateCount = 0;
  return {
    tasks: tasks,
    createCount: function () {
      return createCount;
    },
    updateCount: function () {
      return updateCount;
    },
    fail: function (value) {
      mode = value;
    },
    deleteTask: function (id) {
      delete tasks[id];
    },
    createTask: async function (payload) {
      if (mode === "unavailable") {
        var unavailable = new Error("network down");
        unavailable.code = "unavailable";
        throw unavailable;
      }
      if (mode === "auth") {
        var auth = new Error("Unauthorized");
        auth.code = "auth";
        auth.status = 401;
        throw auth;
      }
      createCount += 1;
      nextId += 1;
      var id = String(nextId);
      tasks[id] = Object.assign({ id: id }, payload);
      return tasks[id];
    },
    updateTask: async function (id, payload) {
      if (mode === "unavailable") {
        var unavailable = new Error("network down");
        unavailable.code = "unavailable";
        throw unavailable;
      }
      if (mode === "auth") {
        var auth = new Error("Unauthorized");
        auth.code = "auth";
        auth.status = 401;
        throw auth;
      }
      if (!tasks[id]) {
        var missing = new Error("Not Found");
        missing.code = "not_found";
        missing.status = 404;
        throw missing;
      }
      updateCount += 1;
      Object.assign(tasks[id], payload);
      return tasks[id];
    }
  };
}

async function run() {
  await test("task title uses course code, not course name", function () {
    var payload = todoist.buildTaskPayload(sampleActivity(), "proj-1");
    assert.strictEqual(payload.content, "MTH301 — Quiz-01");
    assert.ok(payload.description.indexOf("Course: Calculus II") !== -1);
    assert.ok(payload.description.indexOf("Source: VULMS") !== -1);
    assert.strictEqual(payload.due_datetime, "2026-09-06T23:59:00+05:00");
    assert.strictEqual(payload.project_id, "proj-1");
  });

  await test("fee/challan activities are not syncable", function () {
    assert.strictEqual(todoist.isSyncable(sampleActivity({ type: "challan" })), false);
    assert.strictEqual(todoist.isSyncable(sampleActivity()), true);
  });

  await test("Test 1 — new activity with no mapping creates a Todoist task", async function () {
    var api = fakeApi();
    var activity = sampleActivity();
    var result = await todoist.syncActivities([activity], { projectId: "proj-1", todoistTaskIdByActivityId: {} }, api);
    assert.strictEqual(api.createCount(), 1);
    assert.ok(result.mapping[activity.id]);
    assert.strictEqual(api.tasks[result.mapping[activity.id]].content, "MTH301 — Quiz-01");
  });

  await test("Test 2 — existing mapping updates the same Todoist task", async function () {
    var api = fakeApi();
    var activity = sampleActivity();
    var first = await todoist.syncActivities([activity], { projectId: "proj-1", todoistTaskIdByActivityId: {} }, api);
    var taskId = first.mapping[activity.id];
    var second = await todoist.syncActivities(
      [Object.assign({}, activity, { title: "Quiz-01 Extended" })],
      { projectId: "proj-1", todoistTaskIdByActivityId: first.mapping, fingerprints: {} },
      api
    );
    assert.strictEqual(api.createCount(), 1);
    assert.strictEqual(api.updateCount(), 1);
    assert.strictEqual(second.mapping[activity.id], taskId);
    assert.strictEqual(api.tasks[taskId].content, "MTH301 — Quiz-01 Extended");
  });

  await test("Test 3 — deadline change Sep 6 → Sep 8 updates the same task", async function () {
    var api = fakeApi();
    var activity = sampleActivity();
    var first = await todoist.syncActivities([activity], { projectId: "proj-1", todoistTaskIdByActivityId: {} }, api);
    var taskId = first.mapping[activity.id];
    var moved = Object.assign({}, activity, { dueAt: "2026-09-08T23:59:00+05:00" });
    var second = await todoist.syncActivities(
      [moved],
      { projectId: "proj-1", todoistTaskIdByActivityId: first.mapping, fingerprints: first.fingerprints },
      api
    );
    assert.strictEqual(second.mapping[activity.id], taskId);
    assert.strictEqual(api.tasks[taskId].due_datetime, "2026-09-08T23:59:00+05:00");
    assert.strictEqual(api.createCount(), 1);
  });

  await test("Test 4 — mapped task 404 creates a replacement and updates mapping", async function () {
    var api = fakeApi();
    var activity = sampleActivity();
    var first = await todoist.syncActivities([activity], { projectId: "proj-1", todoistTaskIdByActivityId: {} }, api);
    var oldId = first.mapping[activity.id];
    api.deleteTask(oldId);
    var second = await todoist.syncActivities(
      [activity],
      { projectId: "proj-1", todoistTaskIdByActivityId: first.mapping, fingerprints: {} },
      api
    );
    assert.notStrictEqual(second.mapping[activity.id], oldId);
    assert.ok(api.tasks[second.mapping[activity.id]]);
    assert.strictEqual(api.createCount(), 2);
  });

  await test("Test 5 — Todoist unavailable leaves VULMS activities intact", async function () {
    var api = fakeApi();
    api.fail("unavailable");
    var activities = [sampleActivity()];
    var original = JSON.parse(JSON.stringify(activities));
    var result = await todoist.syncActivities(activities, { projectId: "proj-1", todoistTaskIdByActivityId: {} }, api);
    assert.deepStrictEqual(activities, original);
    assert.strictEqual(result.mapping[activities[0].id], undefined);
    assert.ok(result.error);
    assert.strictEqual(result.failed, 1);
  });

  await test("Test 6 — expired authorization stops sync and asks to reconnect", async function () {
    var api = fakeApi();
    api.fail("auth");
    var result = await todoist.syncActivities(
      [sampleActivity()],
      { projectId: "proj-1", todoistTaskIdByActivityId: {} },
      api
    );
    assert.strictEqual(result.authExpired, true);
    assert.ok(/expired|Unauthorized/i.test(result.error));
    assert.strictEqual(api.createCount(), 0);
  });

  await test("Test 7 — running sync twice does not create a duplicate task", async function () {
    var api = fakeApi();
    var activity = sampleActivity();
    var first = await todoist.syncActivities([activity], { projectId: "proj-1", todoistTaskIdByActivityId: {} }, api);
    var second = await todoist.syncActivities(
      [activity],
      {
        projectId: "proj-1",
        todoistTaskIdByActivityId: first.mapping,
        fingerprints: first.fingerprints
      },
      api
    );
    assert.strictEqual(api.createCount(), 1);
    assert.strictEqual(Object.keys(api.tasks).length, 1);
    assert.strictEqual(second.mapping[activity.id], first.mapping[activity.id]);
    assert.strictEqual(second.skipped, 1);
  });

  await test("Test 8 — same stable ID with a new due date updates one task", async function () {
    var api = fakeApi();
    var firstActivity = sampleActivity({ dueAt: "2026-09-06T23:59:00+05:00" });
    var first = await todoist.syncActivities([firstActivity], { projectId: "proj-1", todoistTaskIdByActivityId: {} }, api);
    var extended = sampleActivity({ dueAt: "2026-09-10T23:59:00+05:00" });
    assert.strictEqual(extended.id, firstActivity.id);
    var second = await todoist.syncActivities(
      [extended],
      { projectId: "proj-1", todoistTaskIdByActivityId: first.mapping, fingerprints: first.fingerprints },
      api
    );
    assert.strictEqual(second.mapping[extended.id], first.mapping[firstActivity.id]);
    assert.strictEqual(api.createCount(), 1);
    assert.strictEqual(api.tasks[first.mapping[firstActivity.id]].due_datetime, "2026-09-10T23:59:00+05:00");
  });

  await test("default project prefers University / VU University", function () {
    var picked = todoist.pickDefaultProject([
      { id: "1", name: "Inbox" },
      { id: "2", name: "University" },
      { id: "3", name: "Personal" }
    ]);
    assert.strictEqual(picked.id, "2");
  });

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

run();
