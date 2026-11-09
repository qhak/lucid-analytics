/**
 * Lucid Analytics worker.
 *
 *   POST   /event         public  — receives events from tracker.js
 *   GET    /tracker.js    public  — the script embedded on tracked sites
 *   GET    /api/sites     private — site cards for the index page (daily aggregate sparkline)
 *   POST   /api/sites     private — register a new site to track
 *   DELETE /api/sites     private — remove a site (its events are kept)
 *   GET    /api/stats     private — everything the dashboard renders
 *   GET/POST/DELETE /api/revenue-settings private — per-site revenue rules
 *   GET    /api/journey   private — disabled; new analytics are aggregate-only
 *   GET    /api/visits    private — disabled; no new visit histories are stored
 *   GET    /api/events    private — disabled; use daily action totals in stats
 *   GET    /api/excluded  private — list of places dropped at ingest
 *   POST   /api/excluded  private — add a place to drop
 *   DELETE /api/excluded  private — stop dropping a place
 *   GET    /*             private — dashboard UI (served from ./public)
 *
 * Everything except /event and /tracker.js sits behind HTTP Basic Auth.
 *
 * Sites live in the D1 `sites` table so they can be added from the UI;
 * ALLOWED_SITES in wrangler.toml still works as a bootstrap list and the two
 * are unioned. New requests increment independent daily totals. They do not
 * create visitor IDs, session IDs, exact event timestamps or event properties.
 *
 * Live-only, on purpose: there is no import feature. An importer that has to
 * guess which of two export formats it received, and whether the numbers were
 * filtered when they were exported, is a worse source of truth than a graph
 * that starts at zero and only ever shows what actually happened.
 */

/* ------------------------------------------------------------------ */
/* routing                                                             */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return preflight(request, env);

    if (url.pathname === "/event") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      return handleEvent(request, env, ctx);
    }

    // The tracker is loaded by browsers on the tracked sites, so it is the one
    // asset that must stay public. Everything else requires the password.
    if (url.pathname === "/tracker.js") {
      const res = await env.ASSETS.fetch(request);
      const headers = new Headers(res.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      // Short on purpose: this file changes during active development, and a
      // long cache here means a fix can be deployed and still silently not
      // reach a real browser for up to an hour. Once this is stable, this can
      // safely go back up — a few seconds of staleness on a script this small
      // isn't worth thinking about either way.
      headers.set("Cache-Control", "public, max-age=60");
      // The browser has no way to know this worker's own origin from inside
      // a same-file script tag, so it's baked in at serve time instead of
      // being read off the <script> element (see tracker.js for why that
      // used to be fragile).
      const text = (await res.text()).replace("__LUCID_ENDPOINT__", url.origin);
      return new Response(text, { status: res.status, headers });
    }

    // Everything below is private.
    const challenge = requireAuth(request, env);
    if (challenge) return challenge;

    if (url.pathname === "/api/sites") {
      if (request.method === "GET") return handleSitesSummary(env);
      if (request.method === "POST") return handleSiteAdd(request, env, url);
      if (request.method === "DELETE") return handleSiteRemove(env, url);
      return new Response("Method not allowed", { status: 405 });
    }
    if (url.pathname === "/api/stats") return handleStats(request, env, url);
    if (url.pathname === "/api/revenue-settings") {
      if (request.method === "GET") return handleRevenueSettings(env, url);
      if (request.method === "POST") return handleRevenueSettingsSave(request, env, url);
      if (request.method === "DELETE") return handleRevenueRuleRemove(env, url);
      return new Response("Method not allowed", { status: 405 });
    }
    if (["/api/journey", "/api/visits", "/api/events", "/api/automation"].includes(url.pathname)) {
      return json({ error: "Per-visitor reports are disabled. This dashboard uses aggregate daily totals." }, 410);
    }
    if (url.pathname === "/api/excluded") {
      if (request.method === "GET") return handleExcludedList(env);
      if (request.method === "POST") return handleExcludedAdd(request, env);
      if (request.method === "DELETE") return handleExcludedRemove(env, url);
      return new Response("Method not allowed", { status: 405 });
    }

    // The dashboard shell itself: no cache headers were being set here, so
    // Cloudflare's edge was free to keep serving an old build after a deploy
    // (observed: cf-cache-status: HIT with no Cache-Control at all). This is
    // the whole app's entry point and it's behind a password, so it must
    // never be cached — force a revalidate on every request.
    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    headers.set("Cache-Control", "no-store, must-revalidate");
    return new Response(asset.body, { status: asset.status, headers });
  },

};

/* ------------------------------------------------------------------ */
/* auth                                                                */
/* ------------------------------------------------------------------ */

function requireAuth(request, env) {
  const expected = env.DASH_PASSWORD;
  if (!expected) {
    return json({ error: "DASH_PASSWORD secret is not set. Run: npx wrangler secret put DASH_PASSWORD" }, 500);
  }
  const header = request.headers.get("Authorization") || "";
  if (header.startsWith("Basic ")) {
    let decoded = "";
    try {
      decoded = atob(header.slice(6));
    } catch {
      decoded = "";
    }
    const password = decoded.slice(decoded.indexOf(":") + 1);
    if (timingSafeEqual(password, expected)) return null;
  }
  return new Response("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Lucid Analytics", charset="UTF-8"' },
  });
}

// Constant-time compare so the password can't be guessed byte by byte.
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------------ */
/* site registry (D1 `sites` table ∪ ALLOWED_SITES var)                */
/* ------------------------------------------------------------------ */

let siteCache = { list: null, at: 0 };

async function allowedSites(env) {
  const now = Date.now();
  if (siteCache.list && now - siteCache.at < 60_000) return siteCache.list;

  const fromVar = (env.ALLOWED_SITES || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  let fromDb = [];
  try {
    const { results } = await env.DB.prepare(`SELECT domain FROM sites`).all();
    fromDb = (results || []).map((r) => r.domain);
  } catch {
    /* table may not exist yet — the var list still works */
  }

  siteCache = { list: [...new Set([...fromVar, ...fromDb])], at: now };
  return siteCache.list;
}

function normalizeDomain(input) {
  let d = String(input || "").trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").replace(/^www\./, "");
  d = d.split("/")[0].split("?")[0].split(":")[0];
  return d;
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function snippetFor(domain, origin) {
  // No data-domain attribute needed — the tracker reads location.hostname.
  // domain is only used here to label which site this snippet is for.
  return `<script defer src="${origin}/tracker.js"><\/script> <!-- ${domain} -->`;
}

async function handleSiteAdd(request, env, url) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const domain = normalizeDomain(body.domain);
  if (!DOMAIN_RE.test(domain)) return json({ error: "That doesn't look like a domain." }, 400);

  await env.DB.prepare(`INSERT OR IGNORE INTO sites (domain, created) VALUES (?, ?)`)
    .bind(domain, Math.floor(Date.now() / 1000))
    .run();
  siteCache.at = 0; // new site takes effect immediately

  return json({ ok: true, domain, snippet: snippetFor(domain, url.origin) });
}

async function handleSiteRemove(env, url) {
  const domain = normalizeDomain(url.searchParams.get("domain"));
  if (!domain) return json({ error: "domain is required" }, 400);
  await env.DB.prepare(`DELETE FROM sites WHERE domain = ?`).bind(domain).run();
  siteCache.at = 0;
  // Events are deliberately kept — remove only stops new collection/listing.
  return json({ ok: true, removed: domain, eventsKept: true });
}

/** Site cards show daily aggregate pageview totals and a seven-day sparkline. */
async function handleSitesSummary(env) {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  const weekStart = new Date(Date.now() - 6 * 86400_000).toISOString().slice(0, 10);
  const [cur, prev, spark, withEvents] = await env.DB.batch([
    env.DB.prepare(`SELECT site, SUM(count) AS v FROM daily_analytics
      WHERE day=? AND metric='pageview' AND dimension='all' GROUP BY site`).bind(today),
    env.DB.prepare(`SELECT site, SUM(count) AS v FROM daily_analytics
      WHERE day=? AND metric='pageview' AND dimension='all' GROUP BY site`).bind(yesterday),
    env.DB.prepare(`SELECT site, day AS t, SUM(count) AS v FROM daily_analytics
      WHERE day>=? AND metric='pageview' AND dimension='all' GROUP BY site,day ORDER BY day`).bind(weekStart),
    env.DB.prepare('SELECT DISTINCT site FROM daily_analytics'),
  ]);

  const curMap = Object.fromEntries((cur.results || []).map((r) => [r.site, r.v]));
  const prevMap = Object.fromEntries((prev.results || []).map((r) => [r.site, r.v]));
  const sparkMap = {};
  for (const r of spark.results || []) (sparkMap[r.site] ||= []).push({ t: r.t, v: r.v });
  const domains = new Set([...(await allowedSites(env)), ...(withEvents.results || []).map((r) => r.site)]);
  const sites = [...domains].sort().map((domain) => ({
    domain,
    pageviewsToday: curMap[domain] || 0,
    prevDay: prevMap[domain] || 0,
    delta: pctChange(curMap[domain] || 0, prevMap[domain] || 0),
    spark: sparkMap[domain] || [],
  }));
  sites.sort((a, b) => b.pageviewsToday - a.pageviewsToday);
  return json({ sites });
}
/* ------------------------------------------------------------------ */
/* excluded places (D1 `excluded` table, self-serve from the dashboard) */
/* ------------------------------------------------------------------ */

// ISO2 → full name, so typing "Spain" excludes country code 'ES' too. Only
// needed in the direction of matching a typed name against Cloudflare's code;
// the dashboard already has the reverse map (world-data.js) for display.
const COUNTRY_NAME = {
  AF:"Afghanistan",AL:"Albania",DZ:"Algeria",AR:"Argentina",AM:"Armenia",AU:"Australia",
  AT:"Austria",AZ:"Azerbaijan",BH:"Bahrain",BD:"Bangladesh",BY:"Belarus",BE:"Belgium",
  BO:"Bolivia",BA:"Bosnia and Herzegovina",BR:"Brazil",BG:"Bulgaria",KH:"Cambodia",
  CM:"Cameroon",CA:"Canada",CL:"Chile",CN:"China",CO:"Colombia",CR:"Costa Rica",
  HR:"Croatia",CU:"Cuba",CY:"Cyprus",CZ:"Czechia",DK:"Denmark",DO:"Dominican Republic",
  EC:"Ecuador",EG:"Egypt",SV:"El Salvador",EE:"Estonia",ET:"Ethiopia",FI:"Finland",
  FR:"France",GE:"Georgia",DE:"Germany",GH:"Ghana",GR:"Greece",GT:"Guatemala",
  HN:"Honduras",HK:"Hong Kong",HU:"Hungary",IS:"Iceland",IN:"India",ID:"Indonesia",
  IR:"Iran",IQ:"Iraq",IE:"Ireland",IL:"Israel",IT:"Italy",CI:"Ivory Coast",JM:"Jamaica",
  JP:"Japan",JO:"Jordan",KZ:"Kazakhstan",KE:"Kenya",XK:"Kosovo",KW:"Kuwait",
  KG:"Kyrgyzstan",LA:"Laos",LV:"Latvia",LB:"Lebanon",LY:"Libya",LT:"Lithuania",
  LU:"Luxembourg",MY:"Malaysia",MT:"Malta",MX:"Mexico",MD:"Moldova",MN:"Mongolia",
  ME:"Montenegro",MA:"Morocco",MM:"Myanmar",NP:"Nepal",NL:"Netherlands",
  NZ:"New Zealand",NI:"Nicaragua",NG:"Nigeria",MK:"North Macedonia",NO:"Norway",
  OM:"Oman",PK:"Pakistan",PA:"Panama",PY:"Paraguay",PE:"Peru",PH:"Philippines",
  PL:"Poland",PT:"Portugal",PR:"Puerto Rico",QA:"Qatar",RO:"Romania",RU:"Russia",
  SA:"Saudi Arabia",SN:"Senegal",RS:"Serbia",SG:"Singapore",SK:"Slovakia",SI:"Slovenia",
  ZA:"South Africa",KR:"South Korea",ES:"Spain",LK:"Sri Lanka",SE:"Sweden",
  CH:"Switzerland",SY:"Syria",TW:"Taiwan",TZ:"Tanzania",TH:"Thailand",TN:"Tunisia",
  TR:"Turkey",UG:"Uganda",UA:"Ukraine",AE:"United Arab Emirates",GB:"United Kingdom",
  US:"United States",UY:"Uruguay",UZ:"Uzbekistan",VE:"Venezuela",VN:"Vietnam",
  YE:"Yemen",ZM:"Zambia",ZW:"Zimbabwe",
};

let excludedCache = { set: null, at: 0 };

async function excludedPlaces(env) {
  const now = Date.now();
  if (excludedCache.set && now - excludedCache.at < 60_000) return excludedCache.set;
  const { results } = await env.DB.prepare(`SELECT place FROM excluded`).all();
  excludedCache = {
    set: new Set((results || []).map((r) => r.place.toLowerCase())),
    at: now,
  };
  return excludedCache.set;
}

/** True if this request's country, region, or city is on the exclude list. */
function isExcludedPlace(excluded, cf) {
  if (!excluded.size) return false;
  const candidates = [
    cf.region, cf.city, cf.country, COUNTRY_NAME[cf.country],
  ].filter(Boolean).map((s) => s.toLowerCase());
  return candidates.some((c) => excluded.has(c));
}

async function handleExcludedList(env) {
  const { results } = await env.DB.prepare(`SELECT place, created FROM excluded ORDER BY place`).all();
  return json({ places: (results || []).map((r) => r.place) });
}

async function handleExcludedAdd(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const place = String(body.place || "").trim();
  if (!place) return json({ error: "place is required" }, 400);
  if (place.length > 80) return json({ error: "that's too long to be a place name" }, 400);

  await env.DB.prepare(`INSERT OR IGNORE INTO excluded (place, created) VALUES (?, ?)`)
    .bind(place, Math.floor(Date.now() / 1000))
    .run();
  excludedCache.at = 0;
  return json({ ok: true, place });
}

async function handleExcludedRemove(env, url) {
  const place = String(url.searchParams.get("place") || "").trim();
  if (!place) return json({ error: "place is required" }, 400);
  await env.DB.prepare(`DELETE FROM excluded WHERE place = ?`).bind(place).run();
  excludedCache.at = 0;
  return json({ ok: true, removed: place });
}

const REVENUE_CURRENCIES = new Set(["USD", "GBP", "EUR", "CAD", "AUD"]);

async function revenueSite(url, env) {
  const site = normalizeDomain(url.searchParams.get("site"));
  if (!site || !(await allowedSites(env)).includes(site)) return null;
  return site;
}

async function handleRevenueSettings(env, url) {
  const site = await revenueSite(url, env);
  if (!site) return json({ error: "A registered site is required." }, 400);
  const [setting, rules] = await Promise.all([
    env.DB.prepare(`SELECT currency FROM revenue_settings WHERE site = ?`).bind(site).first(),
    env.DB.prepare(`SELECT event_name AS eventName, amount_minor AS amountMinor FROM revenue_rules WHERE site = ? ORDER BY event_name`).bind(site).all(),
  ]);
  return json({ currency: setting?.currency || "USD", rules: rules.results || [] });
}

async function handleRevenueSettingsSave(request, env, url) {
  const site = await revenueSite(url, env);
  if (!site) return json({ error: "A registered site is required." }, 400);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const currency = String(body.currency || "USD").toUpperCase();
  if (!REVENUE_CURRENCIES.has(currency)) return json({ error: "Choose USD, GBP, EUR, CAD, or AUD." }, 400);
  if (body.eventName == null || body.eventName === "") {
    await env.DB.prepare(`INSERT INTO revenue_settings (site, currency) VALUES (?, ?) ON CONFLICT(site) DO UPDATE SET currency=excluded.currency`).bind(site, currency).run();
    return json({ ok: true, currency });
  }
  const eventName = String(body.eventName).trim();
  const amount = Number(body.amount);
  if (!/^[a-zA-Z0-9:_-]{1,64}$/.test(eventName) || eventName.startsWith("__lucid_") || eventName === "pageview") {
    return json({ error: "Use a custom event name (letters, numbers, _, -, or :)." }, 400);
  }
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) return json({ error: "Enter an amount greater than 0 and at most 1,000,000." }, 400);
  const amountMinor = Math.round(amount * 100);
  if (amountMinor < 1) return json({ error: "Enter at least 0.01." }, 400);
  await env.DB.prepare(`INSERT INTO revenue_settings (site, currency) VALUES (?, ?) ON CONFLICT(site) DO UPDATE SET currency=excluded.currency`).bind(site, currency).run();
  await env.DB.prepare(`INSERT INTO revenue_rules (site, event_name, amount_minor) VALUES (?, ?, ?) ON CONFLICT(site, event_name) DO UPDATE SET amount_minor=excluded.amount_minor`).bind(site, eventName, amountMinor).run();
  return json({ ok: true, currency, eventName, amountMinor });
}

async function handleRevenueRuleRemove(env, url) {
  const site = await revenueSite(url, env);
  const eventName = String(url.searchParams.get("event") || "").trim();
  if (!site || !eventName) return json({ error: "A registered site and event are required." }, 400);
  await env.DB.prepare(`DELETE FROM revenue_rules WHERE site = ? AND event_name = ?`).bind(site, eventName).run();
  return json({ ok: true, removed: eventName });
}

/* ------------------------------------------------------------------ */
/* CORS (only /event is cross-origin)                                  */
/* ------------------------------------------------------------------ */

async function originAllowed(origin, env) {
  if (!origin) return false;
  let host;
  try {
    const parsed = new URL(origin);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== origin) return false;
    host = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }
  if (env.ALLOW_LOCAL_DEV === "1" && (host === "localhost" || host === "127.0.0.1")) return true;
  const sites = await allowedSites(env);
  return sites.some((site) => host === site || host === `www.${site}`);
}

async function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (!(await originAllowed(origin, env))) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    // navigator.sendBeacon() always sends cross-origin requests with
    // credentials included — there's no way to opt out of that from the
    // client. That flips the browser into strict CORS mode, which refuses to
    // accept ANY response (even a successful one already written to D1)
    // unless this header is explicitly "true". No actual cookie is ever set
    // or read here — this is purely satisfying the browser's CORS contract
    // for a request shape sendBeacon forces, not a change in what's tracked.
    "Access-Control-Allow-Credentials": "true",
  };
}

async function preflight(request, env) {
  return new Response(null, { status: 204, headers: await corsHeaders(request, env) });
}

/* ------------------------------------------------------------------ */
/* ingest                                                              */
/* ------------------------------------------------------------------ */

// These are consistency checks, not proof of a human: non-browser clients
// can forge Origin. Check before any aggregate write.
const ALLOWED_EVENT_NAMES = new Set([
  '/background_removal_complete','/background_removal_failed','/custom_background_applied','/custom_background_failed',
  '/listing_analysis_complete','/listing_analysis_failed','/model_photo_complete','/model_photo_failed',
  '/photo_comparison_used','/photo_downloaded','/photo_enhance_complete','/photo_enhance_failed',
  '/photo_upload_failed','/photo_uploaded','/price_estimate_complete','/price_estimate_failed',
  '/price_estimate_limit_reached','/price_estimate_signup_preview','/google_sign_in_complete',
  '/google_sign_in_failed','/password_reset_complete','/password_reset_requested','/password_reset_failed',
  '/sign_up_submitted','/sign_in_complete','/sign_in_failed','/sign_up_failed','/google_sign_in_started','/sign_out_complete',
]);
const ALLOWED_PAGE_PATHS = new Set(['/','/account','/privacy','/terms']);

function domainOf(referrer, site) {
  if (!referrer) return null;
  try {
    const host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, '');
    if (host === site || host.endsWith('.' + site)) return null;
    return host;
  } catch { return null; }
}

const SEARCH_ENGINES = ['google','bing','duckduckgo','yahoo','yandex','baidu','ecosia','startpage','qwant','search.brave'];
const SOCIAL_NETWORKS = ['instagram','facebook','fb.com','tiktok','twitter','x.com','t.co','linkedin','reddit','youtube','pinterest','snapchat','threads','discord','whatsapp','telegram','tumblr','quora'];
function classifyChannel(refDomain) {
  if (!refDomain) return 'Direct';
  if (SEARCH_ENGINES.some((name) => refDomain.includes(name))) return 'Organic Search';
  if (SOCIAL_NETWORKS.some((name) => refDomain.includes(name))) return 'Organic Social';
  return 'Referral';
}

function parseUA(ua) {
  const value = ua || '';
  let browser = 'Unknown';
  if (/Instagram/i.test(value)) browser = 'Instagram';
  else if (/BytedanceWebview|TikTok|musical_ly/i.test(value)) browser = 'TikTok';
  else if (/FBAN|FBAV|FB_IAB/i.test(value)) browser = 'Facebook';
  else if (/Snapchat/i.test(value)) browser = 'Snapchat';
  else if (/LinkedInApp/i.test(value)) browser = 'LinkedIn';
  else if (/Twitter/i.test(value)) browser = 'X';
  else if (/Pinterest/i.test(value)) browser = 'Pinterest';
  else if (/Edg\//i.test(value)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(value)) browser = 'Opera';
  else if (/SamsungBrowser/i.test(value)) browser = 'Samsung Internet';
  else if (/Firefox\/|FxiOS/i.test(value)) browser = 'Firefox';
  else if (/Chrome\/|CriOS/i.test(value)) browser = 'Chrome';
  else if (/Safari\//i.test(value)) browser = 'Safari';
  let os = 'Unknown';
  if (/iPhone|iPad|iPod/i.test(value)) os = 'iOS';
  else if (/Android/i.test(value)) os = 'Android';
  else if (/Windows NT/i.test(value)) os = 'Windows';
  else if (/Mac OS X|Macintosh/i.test(value)) os = 'macOS';
  else if (/CrOS/i.test(value)) os = 'ChromeOS';
  else if (/Linux/i.test(value)) os = 'Linux';
  let device = 'Desktop';
  if (/iPad|Tablet/i.test(value) || (/Android/i.test(value) && !/Mobile/i.test(value))) device = 'Tablet';
  else if (/Mobi|iPhone|iPod|Android/i.test(value)) device = 'Mobile';
  return { browser, os, device };
}

function looksLikeBot(ua) {
  return /bot|crawler|spider|crawling|preview|monitor|curl|wget|python-requests|headless|lighthouse|pingdom|uptime/i.test(ua || '');
}

function validateEvent(body, origin) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'invalid event';
  if (typeof body.d !== 'string' || !DOMAIN_RE.test(body.d)) return 'invalid site';
  if (typeof body.u !== 'string' || body.u.length > 2048) return 'invalid page URL';
  try {
    const page = new URL(body.u);
    if (!['https:', 'http:'].includes(page.protocol) || page.username || page.password) return 'invalid page URL';
    if (page.origin !== origin || normalizeDomain(page.hostname) !== normalizeDomain(body.d)) return 'site/origin mismatch';
  } catch { return 'invalid page URL'; }
  if (body.n !== 'pageview' && !ALLOWED_EVENT_NAMES.has(body.n)) return 'unsupported event name';
  if (body.r != null && (typeof body.r !== 'string' || body.r.length > 2048)) return 'invalid referrer';
  return null;
}

async function handleEvent(request, env) {
  const cors = await corsHeaders(request, env);
  if (!cors['Access-Control-Allow-Origin']) return json({ error: 'origin not allowed' }, 403);

  let body;
  try {
    const raw = await request.text();
    if (raw.length > 2048) return json({ error: 'event too large' }, 413, cors);
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'bad json' }, 400, cors);
  }
  const validationError = validateEvent(body, request.headers.get('Origin'));
  if (validationError) return json({ error: validationError }, 400, cors);

  let pageUrl;
  try { pageUrl = new URL(body.u); } catch { return json({ error: 'invalid page URL' }, 400, cors); }
  if (pageUrl.searchParams.get('lucidignore') === 'true' || pageUrl.searchParams.has('exclude_me')) return json({ ok: true, ignored: 'self' }, 202, cors);

  const site = normalizeDomain(body.d);
  if (!site || !(await allowedSites(env)).includes(site)) return json({ error: 'unknown site' }, 403, cors);

  const cf = request.cf || {};
  if (isExcludedPlace(await excludedPlaces(env), cf)) return json({ ok: true, ignored: 'place' }, 202, cors);
  const ua = request.headers.get('User-Agent') || '';
  if (looksLikeBot(ua)) return json({ ok: true, ignored: 'bot' }, 202, cors);

  // Only fixed public routes are retained. Query strings and fragments never
  // enter the aggregate table, and unrecognized routes collapse to one bucket.
  const requestedPath = pageUrl.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
  const path = ALLOWED_PAGE_PATHS.has(requestedPath) ? requestedPath : '/other';
  const isPageview = body.n === 'pageview';
  const metric = isPageview ? 'pageview' : 'action';
  const name = isPageview ? '' : body.n;
  const day = new Date().toISOString().slice(0, 10);
  const refDomain = isPageview ? domainOf(body.r, site) : null;
  const channel = isPageview ? classifyChannel(refDomain, null) : null;
  const client = isPageview ? parseUA(ua) : null;
  const country = isPageview && /^[A-Z]{2}$/.test(cf.country || '') ? cf.country : null;
  const values = new Map();
  const add = (recordMetric, dimension, value) => {
    if (value == null || value === '') return;
    values.set([recordMetric, dimension, String(value)].join('\u0000'), [recordMetric, dimension, String(value)]);
  };

  // Each dimension is counted independently. There is no row that links a
  // page, action, location, device and referrer to the same request.
  add(metric, 'all', '');
  if (isPageview) {
    add('pageview', 'path', path);
    add('pageview', 'channel', channel);
    add('pageview', 'ref_domain', refDomain);
    add('pageview', 'country', country);
    add('pageview', 'browser', client.browser);
    add('pageview', 'os', client.os);
    add('pageview', 'device', client.device);
  } else {
    add('action', 'name', name);
    add('action', 'path', path);
  }

  const statements = [...values.values()].map(([recordMetric, dimension, value]) =>
    env.DB.prepare(`INSERT INTO daily_analytics (site,day,metric,dimension,value,count)
      VALUES (?,?,?,?,?,1)
      ON CONFLICT(site,day,metric,dimension,value) DO UPDATE SET count=daily_analytics.count+1`)
      .bind(site, day, recordMetric, dimension, value)
  );

  if (!isPageview) {
    const rule = await env.DB.prepare('SELECT amount_minor FROM revenue_rules WHERE site=? AND event_name=?').bind(site, name).first();
    if (rule && Number.isInteger(rule.amount_minor) && rule.amount_minor > 0) {
      const currencyRow = await env.DB.prepare('SELECT currency FROM revenue_settings WHERE site=?').bind(site).first();
      const currency = /^[A-Z]{3}$/.test(currencyRow?.currency || '') ? currencyRow.currency : 'USD';
      statements.push(env.DB.prepare(`INSERT INTO daily_analytics (site,day,metric,dimension,value,count,revenue_minor)
        VALUES (?,?,'revenue','all','',1,?)
        ON CONFLICT(site,day,metric,dimension,value) DO UPDATE SET
          count=daily_analytics.count+1,revenue_minor=daily_analytics.revenue_minor+excluded.revenue_minor`).bind(site, day, rule.amount_minor));
    }
  }

  await env.DB.batch(statements);
  return json({ ok: true, aggregateOnly: true }, 202, cors);
}
const DIMENSIONS = {
  path: "path", channel: "channel", ref_domain: "ref_domain",
  utm_source: "utm_source", utm_medium: "utm_medium", utm_campaign: "utm_campaign",
  country: "country", region: "region", city: "city",
  continent: "continent", timezone: "timezone",
  browser: "browser", os: "os", device: "device",
  network: "network", language: "language",
  name: "name",
};

// Evaluate the costly whole-session rules once per report request. Reuse the
// immutable ID list in every breakdown instead of expanding views ~27 times.
async function automationSessionIds(env, site = null) {
  const result = await env.DB.prepare('SELECT DISTINCT session_id FROM session_automation_exclusions'+(site?' WHERE site=?':'')).bind(...(site?[site]:[])).all();
  return JSON.stringify(result.results.map(row=>row.session_id));
}

function buildWhere(site, from, to, filters, excluded) {
  const clauses = ["site = ?", "ts >= ?", "ts < ?", "session_id IN (SELECT session_id FROM session_quality WHERE qualified=1)", "session_id NOT IN (SELECT value FROM json_each(?))"];
  const binds = [site, from, to, excluded];

  for (const f of filters) {
    const expr = DIMENSIONS[f && f.field];
    if (!expr) continue;
    const values = (Array.isArray(f.value) ? f.value : [f.value]).filter((v) => v != null);
    if (!values.length) continue;
    const placeholders = values.map(() => "?").join(",");
    const op = f.op === "is_not" ? "NOT IN" : "IN";
    clauses.push(`${expr} ${op} (${placeholders})`);
    binds.push(...values.map(String));
  }

  return { where: clauses.join(" AND "), binds };
}

// Inspection counts are site-wide within the selected time range, regardless
// of report dimensions. Bind every user value; only existing rules may toggle.
async function handleAutomation(request, env, url) {
  if (!['GET', 'POST'].includes(request.method)) return json({ error: 'method not allowed' }, 405);
  const site = url.searchParams.get('site');
  if (!site || !(await allowedSites(env)).includes(site)) return json({ error: 'unknown site' }, 400);
  if (request.method === 'POST') {
    if (request.headers.get('Origin') !== url.origin) return json({ error: 'origin not allowed' }, 403);
    let body;
    try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
    if (!body || typeof body.id !== 'string' || typeof body.enabled !== 'boolean') return json({ error: 'invalid rule update' }, 400);
    const rule = await env.DB.prepare('SELECT id FROM automation_rules WHERE id=? AND site=?').bind(body.id,site).first();
    if (!rule) return json({ error: 'unknown rule' }, 404);
    await env.DB.prepare('UPDATE automation_rules SET enabled=? WHERE id=? AND site=?').bind(body.enabled?1:0,body.id,site).run();
    return json({ ok: true });
  }
  const { from, to } = parseRange(url);
  const [rules, counts, sessions] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM automation_rules WHERE site=? ORDER BY id').bind(site),
    env.DB.prepare('SELECT rule_id,reason,COUNT(*) AS sessions FROM session_automation_exclusions WHERE site=? AND first_ts>=? AND first_ts<? GROUP BY rule_id,reason').bind(site,from,to),
    env.DB.prepare('SELECT * FROM session_automation_exclusions WHERE site=? AND first_ts>=? AND first_ts<? ORDER BY first_ts DESC,session_id LIMIT 100').bind(site,from,to),
  ]);
  return json({ site, range: { from,to }, rules:rules.results, counts:counts.results, sessions:sessions.results, limit:100 });
}

function parseFilters(url) {
  try {
    const f = JSON.parse(url.searchParams.get("filters") || "[]");
    return Array.isArray(f) ? f : [];
  } catch {
    return [];
  }
}

/** Accepts either from/to (unix seconds) or days=N. */
function parseRange(url) {
  const now = Math.floor(Date.now() / 1000);
  let to = parseInt(url.searchParams.get("to"), 10);
  let from = parseInt(url.searchParams.get("from"), 10);
  if (!Number.isFinite(to) || to <= 0) to = now;
  if (!Number.isFinite(from) || from < 0) {
    const days = Math.min(Math.max(parseInt(url.searchParams.get("days") || "28", 10), 1), 400);
    from = to - days * 86400;
  }
  if (from >= to) from = to - 86400;
  return { from, to, span: to - from };
}

function shiftDay(day, offset) {
  const date = new Date(day + 'T00:00:00.000Z');
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function fillAggregateSeries(rows, fromDay, toDay, monthly) {
  const byKey = new Map(rows.map((row) => [row.t, row]));
  const out = [];
  if (monthly) {
    const first = fromDay.slice(0, 7).split('-').map(Number);
    const last = toDay.slice(0, 7).split('-').map(Number);
    const cursor = new Date(Date.UTC(first[0], first[1] - 1, 1));
    const end = new Date(Date.UTC(last[0], last[1] - 1, 1));
    while (cursor <= end) {
      const key = cursor.toISOString().slice(0, 7);
      out.push(byKey.get(key) || { t: key, pageviews: 0, actions: 0, revenue_minor: 0 });
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  } else {
    for (let day = fromDay; day <= toDay; day = shiftDay(day, 1)) {
      out.push(byKey.get(day) || { t: day, pageviews: 0, actions: 0, revenue_minor: 0 });
    }
  }
  return out;
}

async function handleStats(request, env, url) {
  const site = url.searchParams.get('site');
  if (!site || !(await allowedSites(env)).includes(site)) return json({ error: 'unknown site' }, 400);

  const { from, to, span } = parseRange(url);
  const toDay = new Date(Math.max(from, to - 1) * 1000).toISOString().slice(0, 10);
  let fromDay = new Date(from * 1000).toISOString().slice(0, 10);
  if (from === 0) {
    const earliest = await env.DB.prepare("SELECT MIN(day) AS day FROM daily_analytics WHERE site=?").bind(site).first();
    fromDay = earliest?.day || toDay;
  }
  if (fromDay > toDay) fromDay = toDay;
  const dayCount = Math.max(1, Math.floor((Date.parse(toDay + 'T00:00:00Z') - Date.parse(fromDay + 'T00:00:00Z')) / 86400000) + 1);
  const previousTo = shiftDay(fromDay, -1);
  const previousFrom = shiftDay(previousTo, -(dayCount - 1));
  const monthly = dayCount > 400;
  const aggregateWhere = `site=? AND day>=? AND day<=?`;
  const total = (start, end) => env.DB.prepare(`SELECT
      COALESCE(SUM(CASE WHEN metric='pageview' AND dimension='all' THEN count ELSE 0 END),0) AS pageviews,
      COALESCE(SUM(CASE WHEN metric='action' AND dimension='all' THEN count ELSE 0 END),0) AS actions,
      COALESCE(SUM(CASE WHEN metric='revenue' AND dimension='all' THEN revenue_minor ELSE 0 END),0) AS revenue_minor
    FROM daily_analytics WHERE ${aggregateWhere}`).bind(site, start, end);
  const breakdown = (metric, dimension, limit = 15) => {
    const limitSql = limit == null ? "" : ` LIMIT ${limit}`;
    return env.DB.prepare(`SELECT value AS k,SUM(count) AS v
      FROM daily_analytics WHERE ${aggregateWhere} AND metric=? AND dimension=?
      GROUP BY value ORDER BY v DESC${limitSql}`).bind(site, fromDay, toDay, metric, dimension);
  };
  const series = env.DB.prepare(`SELECT ${monthly ? "substr(day,1,7)" : 'day'} AS t,
      SUM(CASE WHEN metric='pageview' AND dimension='all' THEN count ELSE 0 END) AS pageviews,
      SUM(CASE WHEN metric='action' AND dimension='all' THEN count ELSE 0 END) AS actions,
      SUM(CASE WHEN metric='revenue' AND dimension='all' THEN revenue_minor ELSE 0 END) AS revenue_minor
    FROM daily_analytics WHERE ${aggregateWhere} GROUP BY t ORDER BY t`).bind(site, fromDay, toDay);

  const result = await env.DB.batch([
    total(fromDay, toDay), total(previousFrom, previousTo), series,
    breakdown('pageview', 'channel'), breakdown('pageview', 'ref_domain'),
    breakdown('pageview', 'path', 30), breakdown('pageview', 'country', null),
    breakdown('pageview', 'browser'), breakdown('pageview', 'os'), breakdown('pageview', 'device'),
    breakdown('action', 'name', 40),
    env.DB.prepare('SELECT currency FROM revenue_settings WHERE site=?').bind(site),
  ]);
  const one = (index) => result[index]?.results?.[0] || {};
  const rows = (index) => result[index]?.results || [];
  const current = one(0);
  const previous = one(1);
  const goals = rows(10).map((row) => ({ k: row.k, events: row.v }));
  return json({
    aggregateOnly: true,
    range: { from, to, span, fromDay, toDay, granularity: monthly ? 'month' : 'day' },
    totals: {
      pageviews: current.pageviews || 0,
      actions: current.actions || 0,
      revenueMinor: current.revenue_minor || 0,
    },
    deltas: {
      pageviews: pctChange(current.pageviews || 0, previous.pageviews || 0),
      actions: pctChange(current.actions || 0, previous.actions || 0),
      revenue: pctChange(current.revenue_minor || 0, previous.revenue_minor || 0),
    },
    timeseries: fillAggregateSeries(rows(2), fromDay, toDay, monthly),
    currency: one(11).currency || 'EUR',
    channels: rows(3),
    sources: rows(4),
    pages: rows(5),
    countries: rows(6),
    browsers: rows(7),
    os: rows(8),
    devices: rows(9),
    goals,
  });
}
/* ---- individual visits: the most detail available per person -------- */

async function handleVisits(env, url) {
  const site = url.searchParams.get("site");
  if (!site) return json({ error: "site is required" }, 400);

  const { from, to } = parseRange(url);
  const cur = buildWhere(site, from, to, parseFilters(url), await automationSessionIds(env,site));
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50", 10), 1), 200);

  // One row per visit. MIN(ts) keyed columns describe how the visit began;
  // entry/exit come from the first and last pageview path.
  const { results } = await env.DB.prepare(
    `WITH ranked AS (
       SELECT *,
              ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ts ASC,  id ASC)  AS first_rn,
              ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ts DESC, id DESC) AS last_rn
         FROM events WHERE ${cur.where}
     )
     SELECT session_id,
            MIN(ts) AS started,
            COALESCE((SELECT CAST(q.visible_ms/1000 AS INTEGER) FROM session_quality q WHERE q.session_id=ranked.session_id),MAX(ts)-MIN(ts)) AS duration,
            SUM(CASE WHEN name = 'pageview' THEN 1 ELSE 0 END) AS pageviews,
            COUNT(*) AS events,
            MAX(CASE WHEN first_rn = 1 THEN country      END) AS country,
            MAX(CASE WHEN first_rn = 1 THEN region       END) AS region,
            MAX(CASE WHEN first_rn = 1 THEN city         END) AS city,
            MAX(CASE WHEN first_rn = 1 THEN timezone     END) AS timezone,
            MAX(CASE WHEN first_rn = 1 THEN browser      END) AS browser,
            MAX(CASE WHEN first_rn = 1 THEN os           END) AS os,
            MAX(CASE WHEN first_rn = 1 THEN device       END) AS device,
            MAX(CASE WHEN first_rn = 1 THEN screen       END) AS screen,
            MAX(CASE WHEN first_rn = 1 THEN network      END) AS network,
            MAX(CASE WHEN first_rn = 1 THEN language     END) AS language,
            MAX(CASE WHEN first_rn = 1 THEN channel      END) AS channel,
            MAX(CASE WHEN first_rn = 1 THEN ref_domain   END) AS ref_domain,
            MAX(CASE WHEN first_rn = 1 THEN is_returning END) AS is_returning,
            MAX(CASE WHEN first_rn = 1 THEN path         END) AS entry,
            MAX(CASE WHEN last_rn  = 1 THEN path         END) AS exit
       FROM ranked
      GROUP BY session_id
      ORDER BY started DESC
      LIMIT ${limit}`
  ).bind(...cur.binds).all();

  return json({ visits: results || [] });
}

/* ---- individual custom events, newest first, with their properties -- */

async function handleEvents(env, url) {
  const site = url.searchParams.get("site");
  if (!site) return json({ error: "site is required" }, 400);

  const { from, to } = parseRange(url);
  const cur = buildWhere(site, from, to, parseFilters(url), await automationSessionIds(env,site));
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50", 10), 1), 200);

  // Custom events only — pageviews carry no properties and already have
  // their own view (Top Pages), so they'd just be noise in this feed.
  const { results } = await env.DB.prepare(
    `SELECT ts, name, path, props, country, region, city,
            browser, os, device, is_returning, channel, ref_domain
       FROM events
      WHERE ${cur.where} AND name != 'pageview'
      ORDER BY ts DESC, id DESC
      LIMIT ${limit}`
  ).bind(...cur.binds).all();

  const events = (results || []).map((r) => {
    let props = null;
    if (r.props) {
      try { props = JSON.parse(r.props); } catch { /* leave null */ }
    }
    return { ...r, props };
  });

  return json({ events });
}

/* ---- journey: what happens 1 and 2 steps after a chosen start ------ */

async function handleJourney(env, url) {
  const site = url.searchParams.get("site");
  const start = url.searchParams.get("start");
  if (!site || !start) return json({ error: "site and start are required" }, 400);

  const { from, to } = parseRange(url);
  const cur = buildWhere(site, from, to, parseFilters(url), await automationSessionIds(env,site));

  // A "step" is the page path for pageviews and the event name otherwise, so
  // the journey reads the way Plausible's does: / → scan_pick → /pricing.
  const { results } = await env.DB.prepare(
    `WITH seq AS (
       SELECT session_id,
              CASE WHEN name = 'pageview' THEN COALESCE(path, '/') ELSE name END AS step,
              ts, id
         FROM events WHERE ${cur.where}
     ),
     chain AS (
       SELECT step,
              LEAD(step, 1) OVER (PARTITION BY session_id ORDER BY ts, id) AS n1,
              LEAD(step, 2) OVER (PARTITION BY session_id ORDER BY ts, id) AS n2
         FROM seq
     )
     SELECT n1, n2, COUNT(*) AS c FROM chain
      WHERE step = ? AND n1 IS NOT NULL
      GROUP BY n1, n2`
  )
    .bind(...cur.binds, start)
    .all();

  const step1 = new Map();
  const step2 = new Map();
  for (const row of results || []) {
    step1.set(row.n1, (step1.get(row.n1) || 0) + row.c);
    if (row.n2 != null) step2.set(row.n2, (step2.get(row.n2) || 0) + row.c);
  }
  const toList = (m) =>
    [...m].map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v).slice(0, 10);

  return json({ start, step1: toList(step1), step2: toList(step2) });
}

/**
 * SQL's GROUP BY only returns buckets that actually had an event, so a
 * single page view in the middle of an otherwise empty day produces one floating
 * point with nothing around it instead of a flat line that jumps when it
 * happens. Fill every bucket in [from, to) with zero counts first, then
 * overlay whatever the query actually found.
 */
function fillBuckets(rows, from, to, hourly) {
  const step = hourly ? 3600 : 86400;
  const keyOf = (t) => {
    const iso = new Date(t * 1000).toISOString();
    return hourly ? iso.slice(0, 13) + ":00" : iso.slice(0, 10);
  };
  const byKey = new Map(rows.map((r) => [r.t, r]));
  const start = Math.floor(from / step) * step;
  const out = [];
  for (let t = start; t < to; t += step) {
    const key = keyOf(t);
    out.push(byKey.get(key) || { t: key, v: 0, visits: 0, pageviews: 0, revenue_minor: 0 });
  }
  return out;
}

function pctChange(now, before) {
  if (!before) return now ? 100 : 0;
  return Math.round(((now - before) / before) * 100);
}

/* ------------------------------------------------------------------ */

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}
