/**
 * Runs only on https://vulms.vu.edu.pk/*
 * Fallback fetch in the page's own origin if the service worker
 * does not receive the existing VULMS session.
 * Does not read cookies, credentials, or unrelated pages.
 */
(function () {
  "use strict";

  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (!message || message.type !== "VU_PAGE_FETCH") {
      return;
    }
    var url = message.url;
    if (typeof url !== "string" || url.indexOf("https://vulms.vu.edu.pk/") !== 0) {
      sendResponse({ ok: false, error: "blocked" });
      return;
    }
    fetch(url, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      redirect: "follow"
    })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("VULMS request failed (" + response.status + ")");
        }
        return response.text();
      })
      .then(function (text) {
        sendResponse({ ok: true, text: text });
      })
      .catch(function (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      });
    return true;
  });
})();
