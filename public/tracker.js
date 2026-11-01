/**
 * Aggregate-only tracker for sites on Listvint's Lucid instance.
 *
 * Sends a page path, a fixed event name and (for page views) the referrer
 * origin. The worker increments daily counters and discards the request IP,
 * full user-agent, exact timestamp and all custom event properties.
 */
(function () {
  "use strict";

  var endpoint = "__LUCID_ENDPOINT__" + "/event";
  var site = location.hostname.replace(/^www\./, "");
  var switches = new URLSearchParams(location.search);
  var ignored = switches.get("lucidignore") === "true" || switches.has("exclude_me");
  var included = switches.get("lucidignore") === "false" || switches.has("include_me");
  var disabled = false;
  try {
    if (included && !ignored) localStorage.removeItem("analytics_ignore");
    if (ignored) localStorage.setItem("analytics_ignore", "1");
    ignored = ignored || localStorage.getItem("analytics_ignore") === "1";
  } catch (_) {}
  if (ignored || location.hostname === "localhost" || location.hostname === "127.0.0.1" || navigator.webdriver) {
    window.stats = function () {};
    return;
  }

  function currentPath() {
    return location.pathname.replace(/\/{2,}/g, "/").slice(0, 160) || "/";
  }

  function safeReferrer() {
    try {
      if (!document.referrer) return null;
      var ref = new URL(document.referrer);
      return ref.origin === location.origin ? null : ref.origin;
    } catch (_) { return null; }
  }

  function send(name) {
    if (disabled || (typeof window.listvintAnalyticsConsent === "function" && !window.listvintAnalyticsConsent())) return;
    if (typeof name !== "string" || !/^(pageview|\/[a-z0-9_/-]{1,60})$/i.test(name)) return;
    var payload = {
      d: site,
      n: name,
      u: location.origin + currentPath(),
      r: name === "pageview" ? safeReferrer() : null,
    };
    var body = JSON.stringify(payload);
    if (navigator.sendBeacon) {
      navigator.sendBeacon(endpoint, new Blob([body], { type: "application/json" }));
    } else {
      fetch(endpoint, { method: "POST", body: body, headers: { "Content-Type": "application/json" }, keepalive: true, mode: "cors" }).catch(function () {});
    }
  }

  var lastPath = null;
  function pageview() {
    var path = currentPath();
    if (path === lastPath) return;
    lastPath = path;
    send("pageview");
  }

  var queued = (window.stats && window.stats.q) || [];
  window.stats = function (name) {
    if (name === "pageview") pageview();
    else send(name);
  };
  for (var i = 0; i < queued.length; i++) window.stats.apply(null, queued[i]);

  var pushState = history.pushState;
  if (pushState) {
    history.pushState = function () { pushState.apply(this, arguments); pageview(); };
    window.addEventListener("popstate", pageview);
  }
  window.addEventListener("pageshow", function (event) { if (event.persisted) { lastPath = null; pageview(); } });
  pageview();

  window.listvintStopLucid = function () {
    disabled = true;
    window.stats = function () {};
  };
})();
