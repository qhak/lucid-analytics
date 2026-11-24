/**
 * Lucid tracker.
 *
 * 1. Aggregate counters: sends a page path, a fixed event name and (for page
 *    views) the referrer origin. The worker increments daily counters.
 * 2. Session replay: records what the visitor sees (rrweb DOM snapshots,
 *    clicks, scrolls) under a random per-tab session ID and uploads it in
 *    chunks to /replay. Form input values are always masked. Elements marked
 *    data-lucid-mask have their text masked; data-lucid-block are not recorded.
 *
 * Both stop when the site's consent hook returns false or listvintStopLucid()
 * is called.
 */
(function () {
  "use strict";

  var base = "__LUCID_ENDPOINT__";
  var endpoint = base + "/event";
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

  function allowed() {
    return !disabled && !(typeof window.listvintAnalyticsConsent === "function" && !window.listvintAnalyticsConsent());
  }

  function send(name) {
    if (!allowed()) return;
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

  /* ---------------- session replay ---------------- */

  var IDLE_MS = 30 * 60 * 1000;      // new session after 30 min without activity
  var FLUSH_MS = 5000;
  var FLUSH_BYTES = 256 * 1024;      // flush early once the buffer gets big
  var BEACON_MAX = 60 * 1024;        // keepalive/sendBeacon bodies must stay under 64KB
  var stopRecording = null;
  var buffer = [], bufferBytes = 0, bufferClicks = 0, flushTimer = null;
  var session = null;
  var pageKey = null; // per page load, so a duplicated tab can't overwrite chunks

  function randomId() {
    var bytes = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    var out = "";
    for (var i = 0; i < bytes.length; i++) out += ("0" + bytes[i].toString(16)).slice(-2);
    return out;
  }

  function loadSession() {
    var now = Date.now(), s = null;
    try { s = JSON.parse(sessionStorage.getItem("lucid_rs") || "null"); } catch (_) {}
    if (!s || typeof s.id !== "string" || !(now - s.last < IDLE_MS)) s = { id: randomId(), seq: 0, last: now };
    return s;
  }

  function saveSession() {
    try { sessionStorage.setItem("lucid_rs", JSON.stringify(session)); } catch (_) {}
  }

  function isClick(e) {
    // rrweb: type 3 = IncrementalSnapshot, source 2 = MouseInteraction, type 2 = Click
    return e.type === 3 && e.data && e.data.source === 2 && e.data.type === 2;
  }

  function upload(events, clicks, final) {
    if (!events.length || !session) return;
    var now = Date.now();
    if (now - session.last >= IDLE_MS) session = { id: randomId(), seq: 0, last: now };
    var seq = session.seq++;
    session.last = now;
    saveSession();
    var url = base + "/replay?d=" + encodeURIComponent(site) + "&s=" + session.id + "&q=" + seq +
      "&k=" + pageKey + "&p=" + encodeURIComponent(currentPath()) + "&c=" + clicks;
    var json = JSON.stringify(events);

    // On page exit there's no time to compress: send plain JSON with a beacon.
    if (final || typeof CompressionStream !== "function") {
      if (json.length <= BEACON_MAX && navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([json], { type: "text/plain" }));
      } else {
        fetch(url, { method: "POST", body: json, keepalive: json.length <= BEACON_MAX, mode: "cors" }).catch(function () {});
      }
      return;
    }
    new Response(new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer().then(function (gz) {
      return fetch(url + "&z=1", { method: "POST", body: gz, keepalive: gz.byteLength <= BEACON_MAX, mode: "cors" });
    }).catch(function () {});
  }

  function flush(final) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    var events = buffer, clicks = bufferClicks;
    buffer = []; bufferBytes = 0; bufferClicks = 0;
    if (allowed()) upload(events, clicks, final);
  }

  function emit(event) {
    if (!allowed()) { stopReplay(); return; }
    buffer.push(event);
    if (isClick(event)) bufferClicks++;
    // Rough size estimate without serializing every mousemove twice.
    bufferBytes += event.type === 2 ? FLUSH_BYTES : 200;
    if (bufferBytes >= FLUSH_BYTES) flush(false);
    else if (!flushTimer) flushTimer = setTimeout(function () { flush(false); }, FLUSH_MS);
  }

  function stopReplay() {
    if (stopRecording) { try { stopRecording(); } catch (_) {} stopRecording = null; }
    buffer = []; bufferBytes = 0; bufferClicks = 0;
  }

  function startReplay() {
    if (!allowed() || stopRecording || !window.Promise || !window.fetch) return;
    session = loadSession();
    saveSession();
    pageKey = randomId().slice(0, 8);
    var run = function () {
      if (!allowed() || !window.rrwebRecord || stopRecording) return;
      stopRecording = window.rrwebRecord.record({
        emit: emit,
        maskAllInputs: true,
        maskTextSelector: "[data-lucid-mask]",
        blockSelector: "[data-lucid-block]",
        slimDOMOptions: "all",
        sampling: { mousemove: 100, scroll: 150, input: "last" },
        recordCanvas: false,
        collectFonts: false,
      }) || null;
    };
    if (window.rrwebRecord) return run();
    var script = document.createElement("script");
    script.src = base + "/replay-recorder.js";
    script.async = true;
    script.onload = run;
    (document.head || document.documentElement).appendChild(script);
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flush(true);
  });
  window.addEventListener("pagehide", function () { flush(true); });
  startReplay();

  window.listvintStopLucid = function () {
    disabled = true;
    window.stats = function () {};
    stopReplay();
  };
})();
