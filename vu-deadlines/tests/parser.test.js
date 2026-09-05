"use strict";

var assert = require("assert");
var path = require("path");
var parser = require(path.join(__dirname, "..", "parser.js"));
var notifications = require(path.join(__dirname, "..", "notifications.js"));
var storage = require(path.join(__dirname, "..", "storage.js"));

var passed = 0;
var failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("ok  - " + name);
  } catch (err) {
    failed += 1;
    console.error("fail - " + name);
    console.error("     " + (err && err.stack ? err.stack : err));
  }
}

var SAMPLE_HTML = [
  "<!DOCTYPE html><html><head></head><body>",
  "<script>",
  "$(function () {",
  "var JsonData = [",
  "  {",
  '    "Semester": "Summer 2026",',
  '    "title": "MTH301: Quiz-01",',
  '    "start": "2026,09,05",',
  '    "end": "2026,09,07",',
  '    "backgroundColor": "linear-gradient(90deg, rgba(0,0,0,0.2) 0%, #f56954 100%) center, #ffffff",',
  '    "borderColor": "#f56954",',
  '    "allDay": "true",',
  '    "coursecode": "MTH301",',
  '    "url": "/ActivityCalendar/OpenActivitySection.aspx?coursecode=MTH301&ActivityType=QuizList",',
  '    "IsExpired": "0",',
  '    "Start": "2026,09,05"',
  "  },",
  "  {",
  '    "Semester": "Summer 2026",',
  '    "title": "CS302: Assignment# 1",',
  '    "start": "2026,09,01",',
  '    "end": "2026,09,11",',
  '    "allDay": "true",',
  '    "coursecode": "CS302",',
  '    "url": "/ActivityCalendar/OpenActivitySection.aspx?coursecode=CS302&ActivityType=Assignment",',
  '    "IsExpired": "0",',
  '    "Start": "2026,09,01"',
  "  },",
  "  {",
  '    "Semester": "Summer 2026",',
  '    "title": "Fee Challan",',
  '    "start": "2026,06,01",',
  '    "end": "2026,06,03",',
  '    "coursecode": "FEE",',
  '    "url": "/ActivityCalendar/OpenActivitySection.aspx?coursecode=FEE&ActivityType=Challan",',
  '    "IsExpired": "1"',
  "  }",
  "];",
  "$('#calendar').fullCalendar({ events: JsonData, editable: false, droppable: false });",
  "});",
  "</script></body></html>"
].join("\n");

var HOME_HTML = [
  '<h3 class="m-portlet__head-text">CS302 - Digital Logic Design</h3>',
  '<h3 class="m-portlet__head-text">MTH301 - Calculus II</h3>'
].join("\n");

test("Test 1 — Date parsing 2026,09,05 -> 2026-09-05", function () {
  var parts = parser.parseVulmsDate("2026,09,05");
  assert.strictEqual(parser.formatYmd(parts), "2026-09-05");
  assert.strictEqual(parts.month, 9);
});

test("Test 2 — Exclusive end date 2026,09,07 -> due 2026-09-06", function () {
  var due = parser.exclusiveEndToDueDate("2026,09,07");
  assert.strictEqual(parser.formatYmd(due), "2026-09-06");
  var activity = parser.normalizeActivity(
    {
      Semester: "Summer 2026",
      title: "MTH301: Quiz-01",
      start: "2026,09,05",
      end: "2026,09,07",
      coursecode: "MTH301",
      url: "/ActivityCalendar/OpenActivitySection.aspx?coursecode=MTH301&ActivityType=QuizList"
    },
    { MTH301: "Calculus II" },
    "2026-09-05T12:00:00+05:00"
  );
  assert.strictEqual(activity.startAt, "2026-09-05T00:00:00+05:00");
  assert.strictEqual(activity.dueAt, "2026-09-06T23:59:00+05:00");
  assert.strictEqual(activity.dueTimeSource, "inferred");
  assert.notStrictEqual(activity.dueAt.slice(0, 10), "2026-09-07");
});

test("Test 3 — January stays January", function () {
  assert.strictEqual(parser.formatYmd(parser.parseVulmsDate("2026,01,10")), "2026-01-10");
});

test("Test 4 — December parses correctly", function () {
  assert.strictEqual(parser.formatYmd(parser.parseVulmsDate("2026,12,31")), "2026-12-31");
});

test("Test 5 — ActivityType=QuizList -> quiz", function () {
  assert.strictEqual(
    parser.detectActivityType("/ActivityCalendar/OpenActivitySection.aspx?coursecode=MTH301&ActivityType=QuizList"),
    "quiz"
  );
});

test("Test 6 — Assignment URL -> assignment", function () {
  assert.strictEqual(
    parser.detectActivityType("/ActivityCalendar/OpenActivitySection.aspx?coursecode=CS302&ActivityType=Assignment"),
    "assignment"
  );
  assert.strictEqual(parser.detectActivityType("/Assignments/StudentAssignmentListView.aspx"), "assignment");
});

test("Test 7 — GDB URL -> gdb", function () {
  assert.strictEqual(
    parser.detectActivityType("/ActivityCalendar/OpenActivitySection.aspx?coursecode=CS302&ActivityType=GDB"),
    "gdb"
  );
  assert.strictEqual(parser.detectActivityType("/GDB/Default.aspx"), "gdb");
});

test("Test 8 — Unknown activity URL -> other", function () {
  assert.strictEqual(
    parser.detectActivityType("/ActivityCalendar/OpenActivitySection.aspx?coursecode=CS302&ActivityType=MDB"),
    "other"
  );
});

test("Test 9 — Stable ID ignores due date changes", function () {
  var first = parser.normalizeActivity(
    {
      Semester: "Summer 2026",
      title: "MTH301: Quiz-01",
      start: "2026,09,05",
      end: "2026,09,07",
      coursecode: "MTH301",
      url: "/ActivityCalendar/OpenActivitySection.aspx?coursecode=MTH301&ActivityType=QuizList"
    },
    {},
    "2026-09-01T00:00:00+05:00"
  );
  var extended = parser.normalizeActivity(
    {
      Semester: "Summer 2026",
      title: "MTH301: Quiz-01",
      start: "2026,09,05",
      end: "2026,09,14",
      coursecode: "MTH301",
      url: "/ActivityCalendar/OpenActivitySection.aspx?coursecode=MTH301&ActivityType=QuizList"
    },
    {},
    "2026-09-08T00:00:00+05:00"
  );
  assert.strictEqual(first.id, "summer-2026:mth301:quiz:1");
  assert.strictEqual(first.id, extended.id);
  assert.notStrictEqual(first.dueAt, extended.dueAt);
});

test("Test 10 — Missing JsonData throws; does not return []", function () {
  var threw = false;
  try {
    parser.extractJsonData("<html><body>Please login</body></html>");
  } catch (err) {
    threw = true;
    assert.strictEqual(err.message, "VULMS calendar format not recognized");
  }
  assert.strictEqual(threw, true);
});

test("extractJsonData reads the array inside a closure, including CSS brackets", function () {
  var data = parser.extractJsonData(SAMPLE_HTML);
  assert.strictEqual(data.length, 3);
  assert.strictEqual(data[0].coursecode, "MTH301");
  assert.ok(data[0].backgroundColor.indexOf("linear-gradient") !== -1);
});

test("month-boundary exclusive end: 2026,10,01 -> 2026-09-30", function () {
  assert.strictEqual(parser.formatYmd(parser.exclusiveEndToDueDate("2026,10,01")), "2026-09-30");
});

test("year-boundary exclusive end: 2027,01,01 -> 2026-12-31", function () {
  assert.strictEqual(parser.formatYmd(parser.exclusiveEndToDueDate("2027,01,01")), "2026-12-31");
});

test("JavaScript 0-based months are not used: 2026,01,10 is not February", function () {
  var parts = parser.parseVulmsDate("2026,01,10");
  assert.strictEqual(parts.month, 1);
  assert.notStrictEqual(parts.month, 2);
});

test("course map from Home.aspx tiles", function () {
  var map = parser.extractCourseMap(HOME_HTML);
  assert.strictEqual(map.CS302, "Digital Logic Design");
  assert.strictEqual(map.MTH301, "Calculus II");
});

test("challan records are dropped from academic activities", function () {
  var dropped = parser.normalizeActivity(
    {
      Semester: "Summer 2026",
      title: "Fee Challan",
      start: "2026,06,01",
      end: "2026,06,03",
      coursecode: "FEE",
      url: "/ActivityCalendar/OpenActivitySection.aspx?ActivityType=Challan"
    },
    {},
    "2026-09-05T00:00:00+05:00"
  );
  assert.strictEqual(dropped, null);
});

test("unknown academic types become other, not discarded", function () {
  var other = parser.normalizeActivity(
    {
      Semester: "Summer 2026",
      title: "CS302: MDB-01",
      start: "2026,10,01",
      end: "2026,10,03",
      coursecode: "CS302",
      url: "/ActivityCalendar/OpenActivitySection.aspx?coursecode=CS302&ActivityType=MDB"
    },
    { CS302: "Digital Logic Design" },
    "2026-09-05T00:00:00+05:00"
  );
  assert.strictEqual(other.type, "other");
  assert.strictEqual(other.id, "summer-2026:cs302:other:1");
  assert.strictEqual(other.courseName, "Digital Logic Design");
});

test("assignment without a number uses a title slug", function () {
  var activity = parser.normalizeActivity(
    {
      Semester: "Summer 2026",
      title: "CS302: Graded Discussion",
      start: "2026,09,05",
      end: "2026,09,07",
      coursecode: "CS302",
      url: "/ActivityCalendar/OpenActivitySection.aspx?coursecode=CS302&ActivityType=Assignment"
    },
    {},
    "2026-09-05T00:00:00+05:00"
  );
  assert.strictEqual(activity.id, "summer-2026:cs302:assignment:graded-discussion");
});

test("deadline extension clears notifiedFor during merge", function () {
  var previous = [
    {
      id: "summer-2026:mth301:quiz:1",
      dueAt: "2026-09-06T23:59:00+05:00",
      firstSeenAt: "2026-09-01T00:00:00+05:00",
      notifiedFor: ["72h", "24h"]
    }
  ];
  var incoming = [
    {
      id: "summer-2026:mth301:quiz:1",
      dueAt: "2026-09-13T23:59:00+05:00",
      firstSeenAt: "2026-09-08T00:00:00+05:00",
      notifiedFor: []
    }
  ];
  var merged = storage.mergeActivities(previous, incoming);
  assert.deepStrictEqual(merged[0].notifiedFor, []);
  assert.strictEqual(merged[0].firstSeenAt, "2026-09-01T00:00:00+05:00");
});

test("notification catch-up sends only the tightest window", function () {
  var due = Date.now() + 90 * 60 * 1000;
  var plan = notifications.planReminders(
    { dueAt: new Date(due).toISOString(), notifiedFor: [] },
    Date.now()
  );
  assert.strictEqual(plan.send, "2h");
  assert.ok(plan.notifiedFor.indexOf("72h") !== -1);
  assert.ok(plan.notifiedFor.indexOf("24h") !== -1);
  assert.ok(plan.notifiedFor.indexOf("2h") !== -1);
});

test("overdue activities are not notified", function () {
  var plan = notifications.planReminders(
    { dueAt: "2020-01-01T23:59:00+05:00", notifiedFor: [] },
    Date.now()
  );
  assert.strictEqual(plan.send, null);
});

test("already sent reminders are not sent again", function () {
  var due = Date.now() + 20 * 60 * 60 * 1000;
  var plan = notifications.planReminders(
    { dueAt: new Date(due).toISOString(), notifiedFor: ["24h", "72h"] },
    Date.now()
  );
  assert.strictEqual(plan.send, null);
});

var digestNow = new Date("2026-09-05T10:00:00+05:00");
var digestActivities = [
  { courseCode: "CS302", title: "Assignment-01", dueAt: "2026-09-01T23:59:00+05:00" },
  { courseCode: "MTH301", title: "Quiz-01", dueAt: "2026-09-06T23:59:00+05:00" },
  { courseCode: "ENG201", title: "GDB-01", dueAt: "2026-09-08T23:59:00+05:00" },
  { courseCode: "CS201", title: "Quiz-02", dueAt: "2026-09-10T23:59:00+05:00" },
  { courseCode: "PHY301", title: "Quiz-03", dueAt: "2026-09-20T23:59:00+05:00" }
];

test("daily digest summarizes this week and names the soonest deadline", function () {
  var plan = notifications.planDigest({ activities: digestActivities }, digestNow);
  assert.strictEqual(plan.send, true);
  assert.strictEqual(plan.lastDigestYmd, "2026-09-05");
  assert.strictEqual(plan.message, "3 due this week — MTH301 Quiz-01 tomorrow");
});

test("daily digest waits until 08:00 Asia/Karachi", function () {
  var plan = notifications.planDigest(
    { activities: digestActivities },
    new Date("2026-09-05T07:30:00+05:00")
  );
  assert.strictEqual(plan.send, false);
});

test("daily digest sends at most once per Karachi day", function () {
  var plan = notifications.planDigest(
    { activities: digestActivities, lastDigestYmd: "2026-09-05" },
    digestNow
  );
  assert.strictEqual(plan.send, false);
});

test("daily digest stays quiet when nothing is due this week", function () {
  var plan = notifications.planDigest(
    { activities: [digestActivities[0], digestActivities[4]] },
    digestNow
  );
  assert.strictEqual(plan.send, false);
});

console.log("");
console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
