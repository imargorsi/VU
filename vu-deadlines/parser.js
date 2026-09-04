/**
 * Pure VULMS calendar parsing helpers.
 * Works in Node tests, the service worker (importScripts), and the content script.
 * Does not execute VULMS JavaScript. Does not touch credentials or cookies.
 */
(function (root) {
  "use strict";

  var KARACHI_OFFSET = "+05:00";
  var ERROR_UNRECOGNIZED = "VULMS calendar format not recognized";

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  /**
   * Parse VULMS calendar dates of the form YYYY,MM,DD.
   * Month is 1-based. Does not use Date string parsing.
   */
  function parseVulmsDate(value) {
    if (value == null) {
      throw new Error("Invalid VULMS date: " + value);
    }
    var parts = String(value).trim().split(",");
    if (parts.length !== 3) {
      throw new Error("Invalid VULMS date: " + value);
    }
    var year = Number(parts[0].trim());
    var month = Number(parts[1].trim());
    var day = Number(parts[2].trim());
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
      throw new Error("Invalid VULMS date: " + value);
    }
    if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
      throw new Error("Invalid VULMS date: " + value);
    }
    var probe = new Date(Date.UTC(year, month - 1, day));
    if (
      probe.getUTCFullYear() !== year ||
      probe.getUTCMonth() + 1 !== month ||
      probe.getUTCDate() !== day
    ) {
      throw new Error("Invalid VULMS date: " + value);
    }
    return { year: year, month: month, day: day };
  }

  function formatYmd(parts) {
    return parts.year + "-" + pad2(parts.month) + "-" + pad2(parts.day);
  }

  /**
   * FullCalendar all-day `end` is exclusive. The real due date is the previous calendar day.
   */
  function exclusiveEndToDueDate(endValue) {
    var end = parseVulmsDate(endValue);
    var utc = Date.UTC(end.year, end.month - 1, end.day);
    var prev = new Date(utc - 24 * 60 * 60 * 1000);
    return {
      year: prev.getUTCFullYear(),
      month: prev.getUTCMonth() + 1,
      day: prev.getUTCDate()
    };
  }

  function toKarachiIso(parts, hours, minutes) {
    return (
      formatYmd(parts) +
      "T" +
      pad2(hours) +
      ":" +
      pad2(minutes) +
      ":00" +
      KARACHI_OFFSET
    );
  }

  /**
   * Extract the JsonData array literal from ActivityCalendar HTML.
   * JsonData lives inside a jQuery ready closure and is not window.JsonData.
   * Nested brackets inside JSON strings (CSS gradients) are handled.
   */
  function extractJsonData(html) {
    if (typeof html !== "string" || !html) {
      throw new Error(ERROR_UNRECOGNIZED);
    }
    var match = /var\s+JsonData\s*=\s*/.exec(html);
    if (!match) {
      throw new Error(ERROR_UNRECOGNIZED);
    }
    var start = match.index + match[0].length;
    while (start < html.length && /\s/.test(html.charAt(start))) {
      start += 1;
    }
    if (html.charAt(start) !== "[") {
      throw new Error(ERROR_UNRECOGNIZED);
    }

    var depth = 0;
    var inString = false;
    var escape = false;
    var i;
    for (i = start; i < html.length; i += 1) {
      var ch = html.charAt(i);
      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === "\\") {
          escape = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "[") {
        depth += 1;
      } else if (ch === "]") {
        depth -= 1;
        if (depth === 0) {
          var literal = html.slice(start, i + 1);
          var data;
          try {
            data = JSON.parse(literal);
          } catch (err) {
            throw new Error(ERROR_UNRECOGNIZED);
          }
          if (!Array.isArray(data)) {
            throw new Error(ERROR_UNRECOGNIZED);
          }
          return data;
        }
      }
    }
    throw new Error(ERROR_UNRECOGNIZED);
  }

  function detectActivityType(url) {
    var value = String(url || "");
    if (/ActivityType=Challan/i.test(value) || /ChallanID=/i.test(value)) {
      return "challan";
    }
    if (/ActivityType=QuizList/i.test(value) || /\/Quiz\//i.test(value)) {
      return "quiz";
    }
    if (/ActivityType=Assignment/i.test(value) || /\/Assignments\//i.test(value)) {
      return "assignment";
    }
    if (/ActivityType=GDB/i.test(value) || /\/GDB\//i.test(value)) {
      return "gdb";
    }
    return "other";
  }

  function isFeeOrChallan(record, type) {
    if (type === "challan") {
      return true;
    }
    var title = String((record && record.title) || "");
    var url = String((record && record.url) || "");
    if (/challan|fee voucher|fee challan/i.test(title)) {
      return true;
    }
    if (/Challan/i.test(url)) {
      return true;
    }
    return false;
  }

  function isAcademicRecord(record) {
    if (!isObject(record)) {
      return false;
    }
    return !isFeeOrChallan(record, detectActivityType(record.url));
  }

  function slugSemester(semester) {
    var slug = String(semester || "unknown")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return slug || "unknown";
  }

  function stripCoursePrefix(title, courseCode) {
    var text = String(title || "").trim();
    if (!courseCode) {
      return text;
    }
    var prefix = new RegExp("^" + String(courseCode).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*[:\\-–]\\s*", "i");
    var stripped = text.replace(prefix, "").trim();
    return stripped || text;
  }

  function extractActivityNumber(title) {
    var text = String(title || "");
    var named = text.match(/(?:quiz|assignment|gdb|mdb|activity)[^\d]{0,12}(\d+)/i);
    if (named) {
      return parseInt(named[1], 10);
    }
    var any = text.match(/(\d+)/);
    if (any) {
      return parseInt(any[1], 10);
    }
    return null;
  }

  function slugTitle(title) {
    var slug = String(title || "item")
      .toLowerCase()
      .replace(/^[a-z]{2,6}\d{2,4}\s*[:\-–]\s*/i, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    return slug || "item";
  }

  /**
   * Stable IDs omit the due date so a deadline extension updates the same activity.
   * semester:courseCode:type:activityNumber
   */
  function makeId(record) {
    var courseCode = String((record && record.coursecode) || (record && record.courseCode) || "unknown").toLowerCase();
    var type = record && record.type ? record.type : detectActivityType(record && record.url);
    var title = stripCoursePrefix((record && record.title) || "", (record && record.coursecode) || (record && record.courseCode));
    var number = extractActivityNumber(title);
    var tail = number != null ? String(number) : slugTitle(title);
    return slugSemester(record && record.Semester) + ":" + courseCode + ":" + type + ":" + tail;
  }

  function absoluteVulmsUrl(url) {
    var fallback = "https://vulms.vu.edu.pk/ActivityCalendar/ActivityCalendar.aspx";
    var value = String(url || "").trim();
    if (!value) {
      return fallback;
    }
    if (/^https?:\/\//i.test(value)) {
      return value.indexOf("https://vulms.vu.edu.pk/") === 0 ? value : fallback;
    }
    if (value.charAt(0) !== "/") {
      value = "/" + value;
    }
    return "https://vulms.vu.edu.pk" + value;
  }

  function normalizeActivity(record, courseMap, fetchedAt) {
    if (!isObject(record)) {
      return null;
    }
    var type = detectActivityType(record.url);
    if (isFeeOrChallan(record, type)) {
      return null;
    }
    var courseCode = String(record.coursecode || "").trim().toUpperCase();
    if (!courseCode) {
      return null;
    }
    var startParts = parseVulmsDate(record.start || record.Start);
    var dueParts = exclusiveEndToDueDate(record.end);
    var title = stripCoursePrefix(record.title || "", courseCode);
    var activityNumber = extractActivityNumber(title);
    var map = courseMap || {};
    var courseName = map[courseCode] || map[courseCode.toLowerCase()] || "";
    var typedRecord = {
      Semester: record.Semester,
      coursecode: courseCode,
      type: type,
      title: title,
      url: record.url
    };
    return {
      id: makeId(typedRecord),
      courseCode: courseCode,
      courseName: courseName,
      type: type,
      title: title,
      activityNumber: activityNumber,
      semester: record.Semester ? String(record.Semester) : "",
      startAt: toKarachiIso(startParts, 0, 0),
      dueAt: toKarachiIso(dueParts, 23, 59),
      dueTimeSource: "inferred",
      totalMarks: null,
      status: "pending",
      sourceUrl: absoluteVulmsUrl(record.url),
      firstSeenAt: fetchedAt,
      fetchedAt: fetchedAt,
      notifiedFor: []
    };
  }

  /**
   * Home.aspx course tiles: <h3 class="m-portlet__head-text">CS302 - Digital Logic Design</h3>
   */
  function extractCourseMap(html) {
    var map = {};
    if (typeof html !== "string" || !html) {
      return map;
    }
    var h3Re = /<h3\b[^>]*>([\s\S]*?)<\/h3>/gi;
    var match;
    while ((match = h3Re.exec(html))) {
      var text = match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      var parsed = text.match(/^([A-Za-z]{2,6}\d{2,4})\s*[-–:]\s*(.+)$/);
      if (parsed) {
        map[parsed[1].toUpperCase()] = parsed[2].trim();
      }
    }
    return map;
  }

  function calendarLooksAuthenticated(html) {
    try {
      extractJsonData(html);
      return true;
    } catch (err) {
      return false;
    }
  }

  var api = {
    ERROR_UNRECOGNIZED: ERROR_UNRECOGNIZED,
    parseVulmsDate: parseVulmsDate,
    formatYmd: formatYmd,
    exclusiveEndToDueDate: exclusiveEndToDueDate,
    toKarachiIso: toKarachiIso,
    extractJsonData: extractJsonData,
    detectActivityType: detectActivityType,
    makeId: makeId,
    normalizeActivity: normalizeActivity,
    extractCourseMap: extractCourseMap,
    calendarLooksAuthenticated: calendarLooksAuthenticated,
    stripCoursePrefix: stripCoursePrefix,
    isAcademicRecord: isAcademicRecord
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.VuParser = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
