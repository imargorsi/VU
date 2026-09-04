# VU Buddy

A small Manifest V3 Chrome extension by **Ar Gorsi**. It reads your VULMS To Do Calendar while you are already logged in, stores assignment / quiz / GDB deadlines locally, and reminds you before they are due.

VULMS course codes such as `MTH301` and `CS302` are easy to forget. This extension keeps the deadlines in a popup dashboard and in Chrome notifications.

## What it does

- Syncs [ActivityCalendar.aspx](https://vulms.vu.edu.pk/ActivityCalendar/ActivityCalendar.aspx) on a 6-hour alarm, on browser startup, and when you click **Sync Now**
- Maps course codes to names from [Home.aspx](https://vulms.vu.edu.pk/Home.aspx)
- Shows assignments, quizzes, GDBs, and unknown academic types
- Sorts overdue items first, then the nearest upcoming deadline
- Sends Chrome notifications 72 hours, 24 hours, and 2 hours before a deadline
- Stores everything in `chrome.storage.local`
- Optionally syncs those local deadlines into a Todoist project you choose

It does not include a backend, accounts, analytics, Google Calendar, WhatsApp, or AI.

## Privacy

This extension does not use a server, analytics, tracking, advertising, or a cloud database.

**Without Todoist:** VULMS data stays in your browser. Network traffic is only `https://vulms.vu.edu.pk/*`.

**With Todoist enabled:** Selected VULMS deadline data (course code, title, type, semester, due date, and activity URL) is sent to Todoist. VULMS usernames, passwords, cookies, and session tokens are never sent to Todoist.

The extension:

- never asks for your VULMS username or password
- never asks for your Todoist password
- never reads cookie values
- never stores roll numbers or VULMS session tokens
- does not load remote JavaScript, Google Fonts, or analytics

The `connect-src` Content Security Policy on extension pages can talk only to VULMS and, after you connect Todoist, the official Todoist API.

## Permissions

| Permission | Why it exists |
| --- | --- |
| `storage` | Cache deadlines, course names, sync timestamps, reminder flags, and Todoist mappings |
| `alarms` | MV3 service workers are killed when idle. Alarms are required for periodic sync and reminder checks |
| `notifications` | Deadline reminders |
| `host_permissions: https://vulms.vu.edu.pk/*` | Fetch the calendar and home page using your existing VULMS session |
| `optional_permissions: identity` | Requested only when you click Connect Todoist. Used for the OAuth window |
| `optional_host_permissions: https://api.todoist.com/*` | Requested only when connecting Todoist. Token exchange and REST API |
| `optional_host_permissions: https://app.todoist.com/*` | Requested only when connecting Todoist. OAuth consent page |

Not requested: `tabs`, `scripting`, `activeTab`, `cookies`, `webRequest`, `declarativeNetRequest`, `<all_urls>`.

A content script is declared only for `https://vulms.vu.edu.pk/*`. That is a fallback fetch in the page origin. It is not extra permission, and it does not run on other sites.

## How VULMS authentication works

VULMS is an ASP.NET WebForms app. The calendar GET does not need ViewState, CSRF tokens, or a JSON API.

Chrome attaches the cookies it already has for `vulms.vu.edu.pk` to extension requests for that host. The extension never sees the cookie. The VULMS session cookie is HttpOnly.

If the session has expired, VULMS returns a login page instead of the calendar. The parser looks for `var JsonData = [...]`. If that pattern is missing:

- previously stored deadlines are kept
- sync status becomes `stale`
- the popup shows **Please sign in to VULMS to refresh deadlines.**
- a button opens VULMS
- the extension never tries to log in for you

## How the calendar is parsed

The calendar page embeds:

```js
var JsonData = [
  {
    "Semester": "Summer 2026",
    "title": "MTH301: Quiz-01",
    "start": "2026,09,05",
    "end": "2026,09,07",
    "coursecode": "MTH301",
    "url": "/ActivityCalendar/OpenActivitySection.aspx?coursecode=MTH301&ActivityType=QuizList"
  }
];
```

`JsonData` is inside a jQuery `$(function () { ... })` closure, so it is not `window.JsonData`. The extension extracts the array literal from the HTML and `JSON.parse`s it. It does not execute VULMS JavaScript.

If extraction fails, it throws `VULMS calendar format not recognized`. That is not treated as “there are no deadlines”.

Fee / challan rows are dropped. Unknown academic `ActivityType` values become `other` and still appear in the list.

## Why the due date is `end - 1` day

FullCalendar uses an **exclusive** all-day `end`.

Example:

- `start = 2026,09,05`
- `end   = 2026,09,07`

The last inclusive day is **6 September 2026**, not the 7th.

V1 does not have an exact clock time from the calendar (every event is `allDay: "true"`). Due time is stored as `23:59` Asia/Karachi with `dueTimeSource: "inferred"`.

Dates are parsed as `YYYY,MM,DD` with a 1-based month. The code never uses `new Date("2026,09,06")`.

## Stable IDs

IDs do not include the due date:

```text
summer-2026:mth301:quiz:1
```

If a teacher extends a deadline, the same activity is updated. Reminder flags are cleared when the due date moves later.

## Data stored locally

```json
{
  "activities": [],
  "courseMap": {},
  "lastSuccessfulSync": null,
  "lastSyncAttempt": null,
  "syncStatus": "never",
  "syncError": null,
  "fetchPath": null,
  "sessionDiagnostic": null
}
```

Not stored: VULMS password, username, roll number, cookies, or VULMS session tokens.

Todoist access/refresh tokens are stored separately in `vuTodoistAuth` only after you connect Todoist, and only the service worker reads that key.

## How to load the extension in Chrome

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select the `vu-deadlines` folder
5. Sign in to [VULMS](https://vulms.vu.edu.pk/) in a normal tab
6. Open the extension popup and click **Sync Now** if the first automatic sync ran before you were signed in

## How to run tests

From this folder:

```bash
node tests/parser.test.js
node tests/todoist.test.js
```

No extra packages are required.

## Architecture

```text
Chrome Alarm
     ↓
Service Worker
     ↓
Fetch ActivityCalendar.aspx  (credentials: "include")
     ↓
Extract JsonData
     ↓
Parse JSON
     ↓
Fetch Home.aspx
     ↓
Build courseCode → courseName
     ↓
Normalize activities
     ↓
Stable IDs + upsert
     ↓
chrome.storage.local
     ↓
Popup UI + notifications
     ↓
Optional Todoist adapter (never inside the VULMS parser)
```

If the service-worker fetch comes back as a login page while a VULMS tab is open, the content script retries the same URLs in the page context and messages the HTML back. Parsing still happens in shared `parser.js`.

## Known limitations

- Exact quiz/assignment clock times are not fetched in V1. Time is inferred as 11:59 PM Pakistan time.
- GDB calendar shape was not confirmed in the original VULMS investigation (no GDB was posted in that session). GDB URLs are detected if they appear.
- Course names are missing if `Home.aspx` cannot be parsed; the popup then shows the course code only.
- Service-worker cookie attachment is the remaining runtime uncertainty. Chrome normally sends SameSite=Lax cookies with host-permission fetches, but that was not empirically verified against a live VULMS session during this build. The content-script fallback exists for that case, and it only works while a VULMS tab is open.
- Popup filters are All / Assignment / Quiz / GDB, plus a small course dropdown when more than one course is present.

## Todoist Integration

Todoist is optional. If you never connect it, the extension behaves exactly as V1: local VULMS deadlines and Chrome notifications only.

### How to connect

1. Load the unpacked extension and open the popup.
2. Click **Connect Todoist**. Chrome will ask for the extra `identity` and Todoist host permissions.
3. Authorize VU Buddy in the Todoist OAuth window.
4. Choose a Todoist project, or click **Create "VU University" project**.
5. Click **Sync to Todoist**, or leave **Automatically sync new/changed deadlines** checked.

No Todoist API token is pasted. No Todoist password is stored.

OAuth uses Todoist's public-client path:

1. Dynamic client registration at `https://api.todoist.com/oauth/register` with `token_endpoint_auth_method: none`
2. Authorization code + PKCE at `https://app.todoist.com/oauth/authorize`
3. Token exchange at `https://api.todoist.com/oauth/access_token` **without a client secret**

Access and refresh tokens are stored in `chrome.storage.local` under `vuTodoistAuth`. Only the service worker reads that key. The popup, content script, and VULMS pages never see tokens.

### What is synchronized

Each VULMS activity becomes one Todoist task:

```text
MTH301 — Quiz-01
```

The due date is the normalized VULMS deadline. The description includes course name, code, type, semester, and a VULMS link.

Stable VULMS IDs such as `summer-2026:mth301:quiz:1` are mapped to Todoist task IDs locally. A deadline extension updates the existing task. It does not create a duplicate.

If a mapped Todoist task was deleted, the next sync creates a replacement and updates the mapping.

If an activity disappears from VULMS, the Todoist task is left untouched. V1 never deletes Todoist tasks.

**Disconnect Todoist** removes local OAuth tokens. Existing Todoist tasks are not deleted. Mappings are kept so a later reconnect can update the same tasks.

Automatic sync runs after a successful VULMS sync, and only if Todoist is connected, a project is selected, and the checkbox is on. A Todoist failure never clears the VULMS cache.

Labels are not created automatically.

## Future V2 ideas

- Sequential `OpenActivitySection.aspx` fetches for exact quiz end times, marks, and submitted status
- “Deadline extended” notification
- Per-course mute / snooze
- Hide submitted work

Those are intentionally not in V1.
