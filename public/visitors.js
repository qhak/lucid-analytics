/**
 * Visitors panel + session replay viewer.
 *
 *   LucidVisitors.mount(el, getQuery)  — renders the visitor list into `el`.
 *     getQuery() returns { site, from, to } (epoch seconds) from dashboard state.
 *   LucidVisitors.refresh()            — re-fetch the list (range/site change, poll).
 *
 * Clicking a visitor opens a full-screen viewer: rrweb player on the left and a
 * step list on the right (page loads + every click). Choosing a step jumps the
 * player to just after that moment and pauses, so you see the page as it looked
 * after the click. ←/→ step through clicks, Esc closes.
 */
(function () {
  "use strict";

  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var el = null, getQuery = null, sessions = [], loading = false;

  function flag(cc) {
    if (!/^[A-Z]{2}$/.test(cc || "")) return "";
    return String.fromCodePoint.apply(null, cc.split("").map(function (c) { return 127397 + c.charCodeAt(0); }));
  }
  function ago(ms) {
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" }) + ", " +
      new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  function dur(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + String(s % 60).padStart(2, "0") + "s";
  }
  function clock(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  /* ---------------- list ---------------- */

  function mount(target, query) {
    el = target; getQuery = query; sessions = [];
    el.innerHTML = '<div class="empty">Loading visitors…</div>';
    el.addEventListener("click", function (e) {
      var row = e.target.closest("[data-sid]");
      if (row) openViewer(row.dataset.sid);
      if (e.target.closest("[data-more]")) loadMore();
    });
    el.addEventListener("keydown", function (e) {
      var row = e.target.closest("[data-sid]");
      if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openViewer(row.dataset.sid); }
    });
    refresh();
  }

  async function fetchPage(before) {
    var q = getQuery();
    var params = new URLSearchParams({ site: q.site, from: q.from, to: q.to, limit: 50 });
    if (before) params.set("before", before);
    var res = await fetch("/api/replays?" + params);
    if (!res.ok) throw new Error("Could not load visitors (" + res.status + ")");
    return res.json();
  }

  var refreshToken = 0;
  async function refresh() {
    if (!el || document.getElementById("lv-viewer")) return;
    var token = ++refreshToken, target = el; // latest call wins (range/site may change mid-request)
    try {
      var data = await fetchPage(null);
      if (token !== refreshToken || target !== el) return;
      sessions = data.sessions;
      render(data);
    } catch (err) {
      if (token === refreshToken && target === el) el.innerHTML = '<div class="empty">' + esc(err.message) + "</div>";
    }
  }

  async function loadMore() {
    if (loading || !sessions.length) return;
    loading = true;
    try {
      var data = await fetchPage(sessions[sessions.length - 1].last_at);
      sessions = sessions.concat(data.sessions);
      render(data, data.sessions.length < 50);
    } finally { loading = false; }
  }

  function render(data, exhausted) {
    if (!data.configured) {
      el.innerHTML = '<div class="empty">Session recording storage isn\'t set up yet. Create the R2 bucket (see README → Session replay) and redeploy.</div>';
      return;
    }
    if (!sessions.length) {
      el.innerHTML = '<div class="empty">No recorded visitors in this period yet. New visits appear here within a few seconds.</div>';
      return;
    }
    var rows = sessions.map(function (s) {
      var live = Date.now() - s.last_at < 60000;
      var where = s.entry_path === s.last_path ? esc(s.entry_path) : esc(s.entry_path) + ' <span class="lv-arrow">→</span> ' + esc(s.last_path);
      return '<div class="lv-row" role="button" tabindex="0" data-sid="' + esc(s.id) + '" aria-label="Watch visit from ' + esc(ago(s.started_at)) + '">' +
        '<span class="lv-when">' + (live ? '<span class="lv-live" title="Active in the last minute"></span>' : "") + esc(ago(s.started_at)) + "</span>" +
        '<span class="lv-where" title="' + esc(s.entry_path + " → " + s.last_path) + '">' + where + "</span>" +
        '<span class="lv-num tabular">' + s.pages + (s.pages === 1 ? " page" : " pages") + "</span>" +
        '<span class="lv-num tabular">' + s.clicks + (s.clicks === 1 ? " click" : " clicks") + "</span>" +
        '<span class="lv-num tabular">' + dur(s.last_at - s.started_at) + "</span>" +
        '<span class="lv-who">' + flag(s.country) + " " + esc([s.device, s.browser].filter(Boolean).join(" · ")) + "</span>" +
        '<span class="lv-play" aria-hidden="true">▶</span></div>';
    }).join("");
    var more = !exhausted && sessions.length % 50 === 0 ? '<button class="lv-more" data-more>Load more</button>' : "";
    el.innerHTML = '<div class="lv-list">' + rows + "</div>" + more +
      '<p class="lv-note">Recordings are kept ' + data.retentionDays + ' days. Form fields are always hidden.</p>';
  }

  /* ---------------- viewer ---------------- */

  var viewer = null; // { root, player, steps, start, onKey }

  function closeViewer() {
    if (!viewer) return;
    document.removeEventListener("keydown", viewer.onKey);
    if (viewer.onResize) window.removeEventListener("resize", viewer.onResize);
    try { viewer.player && viewer.player.pause(); } catch (_) {}
    viewer.root.remove();
    document.body.classList.remove("lv-noscroll");
    var row = el && el.querySelector('[data-sid="' + viewer.sid + '"]');
    viewer = null;
    if (row) row.focus();
  }

  function buildSteps(events) {
    var start = events[0].timestamp, steps = [], clickN = 0;
    events.forEach(function (e) {
      if (e.type === 4 && e.data && e.data.href) { // Meta: a page load
        var path;
        try { path = new URL(e.data.href).pathname; } catch (_) { path = e.data.href; }
        steps.push({ kind: "page", t: e.timestamp - start, label: path });
      } else if (e.type === 3 && e.data && e.data.source === 2 && e.data.type === 2) { // click
        clickN++;
        steps.push({ kind: "click", t: e.timestamp - start, n: clickN, id: e.data.id, label: "Click " + clickN });
      }
    });
    return { start: start, steps: steps };
  }

  function describeNode(node) {
    if (!node) return null;
    var elx = node.nodeType === 1 ? node : node.parentElement;
    if (!elx) return null;
    var target = elx.closest("a,button,[role=button],input,select,textarea,label,summary") || elx;
    var tag = target.tagName.toLowerCase();
    var isField = tag === "input" || tag === "textarea" || tag === "select";
    var text;
    if (isField) {
      // Name the field, never its (masked) value.
      var doc = target.ownerDocument;
      var label = (target.id && doc.querySelector('label[for="' + target.id.replace(/"/g, "") + '"]')) || target.closest("label");
      text = target.getAttribute("aria-label") || (label && label.innerText) || target.getAttribute("placeholder") || target.getAttribute("name") || "";
    } else {
      text = target.getAttribute("aria-label") || target.innerText || target.getAttribute("alt") || target.getAttribute("title") || "";
    }
    text = text.replace(/\*{3,}/g, "").replace(/\s+/g, " ").trim();
    if (text.length > 48) text = text.slice(0, 47) + "…";
    var kind = { a: "link", button: "button", input: "field", select: "dropdown", textarea: "text box", summary: "toggle" }[tag] ||
      (target.getAttribute("role") === "button" ? "button" : "");
    if (!text) return kind || tag;
    return (kind ? kind + " " : "") + "“" + text + "”";
  }

  async function openViewer(sid) {
    closeViewer();
    var root = document.createElement("div");
    root.id = "lv-viewer";
    root.className = "lv-viewer";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "Visitor recording");
    root.innerHTML = '<div class="lv-head"><div class="lv-title" id="lv-title">Loading recording…</div>' +
      '<div class="lv-head-actions"><button class="lv-btn" id="lv-prev" disabled>← Prev click</button>' +
      '<button class="lv-btn" id="lv-next" disabled>Next click →</button>' +
      '<button class="lv-btn lv-close" id="lv-close" aria-label="Close recording">✕</button></div></div>' +
      '<div class="lv-body"><div class="lv-stage" id="lv-stage"></div><ol class="lv-steps" id="lv-steps"></ol></div>';
    document.body.appendChild(root);
    document.body.classList.add("lv-noscroll");
    viewer = { root: root, sid: sid, player: null, steps: [], current: -1 };
    viewer.onKey = function (e) {
      if (e.key === "Escape") closeViewer();
      else if (e.key === "ArrowRight") stepClick(1);
      else if (e.key === "ArrowLeft") stepClick(-1);
    };
    document.addEventListener("keydown", viewer.onKey);
    root.querySelector("#lv-close").addEventListener("click", closeViewer);
    root.querySelector("#lv-close").focus();

    var data;
    try {
      var res = await fetch("/api/replay?id=" + encodeURIComponent(sid));
      data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load recording (" + res.status + ")");
    } catch (err) {
      if (viewer && viewer.sid === sid) root.querySelector("#lv-stage").innerHTML = '<div class="empty">' + esc(err.message) + "</div>";
      return;
    }
    if (!viewer || viewer.sid !== sid) return;

    var events = data.events.sort(function (a, b) { return a.timestamp - b.timestamp; });
    var s = data.session;
    root.querySelector("#lv-title").innerHTML = "<strong>" + flag(s.country) + " " + esc([s.device, s.os, s.browser].filter(Boolean).join(" · ")) + "</strong>" +
      '<span class="lv-sub">' + esc(new Date(s.started_at).toLocaleString()) + " · " + s.pages + " pages · " + s.clicks + " clicks</span>";
    var hasSnapshot = events.some(function (e) { return e.type === 2; });
    if (events.length < 2 || !hasSnapshot) {
      root.querySelector("#lv-stage").innerHTML = '<div class="empty">This visit was too short to record anything to replay.</div>';
      return;
    }

    var built = buildSteps(events);
    viewer.steps = built.steps;
    var stage = root.querySelector("#lv-stage");
    var Player = window.rrwebPlayer && (window.rrwebPlayer.default || window.rrwebPlayer);
    if (!Player) { stage.innerHTML = '<div class="empty">The replay player failed to load. Reload the page and try again.</div>'; return; }
    await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
    if (!viewer || viewer.sid !== sid) return;
    var size = stageSize(stage);
    viewer.player = new Player({
      target: stage,
      props: {
        events: events,
        width: size.width,
        height: size.height,
        autoPlay: false,
        skipInactive: true,
        showController: true,
        mouseTail: { strokeStyle: "#2563eb", lineWidth: 2 },
        UNSAFE_replayCanvas: false,
      },
    });
    viewer.onResize = function () {
      if (!viewer || !viewer.player) return;
      var s2 = stageSize(stage);
      viewer.player.$set({ width: s2.width, height: s2.height });
      viewer.player.triggerResize();
    };
    window.addEventListener("resize", viewer.onResize);
    renderSteps();
    root.querySelector("#lv-prev").addEventListener("click", function () { stepClick(-1); });
    root.querySelector("#lv-next").addEventListener("click", function () { stepClick(1); });
    root.querySelector("#lv-steps").addEventListener("click", function (e) {
      var li = e.target.closest("[data-i]");
      if (li) showStep(Number(li.dataset.i));
    });
    var firstClick = viewer.steps.findIndex(function (st) { return st.kind === "click"; });
    root.querySelector("#lv-next").disabled = firstClick < 0;
  }

  // Player area minus the stage padding (16px each side) and the controller bar (~80px).
  function stageSize(stage) {
    var w = stage.clientWidth || (window.innerWidth - (window.innerWidth > 900 ? 300 : 0));
    var h = stage.clientHeight || (window.innerHeight - 64);
    return { width: Math.max(320, w - 34), height: Math.max(240, h - 34 - 80) };
  }

  function renderSteps() {
    var list = viewer.root.querySelector("#lv-steps");
    if (!viewer.steps.length) { list.innerHTML = '<li class="lv-step-empty">No clicks in this visit.</li>'; return; }
    list.innerHTML = viewer.steps.map(function (st, i) {
      var icon = st.kind === "page" ? "📄" : "👆";
      var text = st.kind === "page" ? "Opened " + esc(st.label) : esc(st.desc || st.label);
      return '<li><button class="lv-step' + (i === viewer.current ? " on" : "") + '" data-i="' + i + '">' +
        '<span class="lv-step-ico" aria-hidden="true">' + icon + "</span>" +
        '<span class="lv-step-text">' + text + "</span>" +
        '<span class="lv-step-t tabular">' + clock(st.t) + "</span></button></li>";
    }).join("");
  }

  // Jump to just after the step and pause: the page as it looked after the click.
  function showStep(i) {
    var st = viewer && viewer.steps[i];
    if (!st || !viewer.player) return;
    viewer.current = i;
    var settle = st.kind === "click" ? 600 : 300;
    viewer.player.goto(st.t + settle, false);
    if (st.kind === "click" && !st.desc) {
      try {
        var node = viewer.player.getReplayer().getMirror().getNode(st.id);
        var d = describeNode(node);
        if (d) st.desc = "Clicked " + d;
      } catch (_) {}
    }
    renderSteps();
    var on = viewer.root.querySelector(".lv-step.on");
    // Keep focus in our UI: renderSteps() replaced the focused button, and
    // focus landing in the replay iframe would swallow Esc/arrow keys.
    if (on) { on.scrollIntoView({ block: "nearest" }); on.focus({ preventScroll: true }); }
    var clicks = viewer.steps.map(function (s, j) { return s.kind === "click" ? j : -1; }).filter(function (j) { return j >= 0; });
    viewer.root.querySelector("#lv-prev").disabled = !clicks.some(function (j) { return j < i; });
    viewer.root.querySelector("#lv-next").disabled = !clicks.some(function (j) { return j > i; });
  }

  function stepClick(dir) {
    if (!viewer || !viewer.steps.length) return;
    var i = viewer.current;
    do { i += dir; } while (i >= 0 && i < viewer.steps.length && viewer.steps[i].kind !== "click");
    if (i >= 0 && i < viewer.steps.length) showStep(i);
  }

  window.LucidVisitors = { mount: mount, refresh: refresh, open: openViewer };
})();
