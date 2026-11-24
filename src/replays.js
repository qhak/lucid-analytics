/**
 * Session replay storage.
 *
 *   POST /replay              public  — tracker uploads a chunk of rrweb events
 *   GET  /replay-recorder.js  public  — vendored rrweb recorder, loaded by tracker.js
 *   GET  /api/replays         private — list recorded sessions for a site + range
 *   GET  /api/replay          private — one session's metadata and all its events
 *
 * Chunks live in R2 (binding REPLAYS) at  <site>/<session>/<seq>-<pageKey>,
 * gzip or plain JSON arrays. One row per session in D1 `replay_sessions`
 * holds the summary the list view needs. Both expire after RETENTION_DAYS
 * (see purgeExpiredReplays, run from the cron trigger).
 *
 * Helpers shared with worker.js are passed in as `h` so this module has no
 * import cycle and can be tested on its own.
 */

export const RETENTION_DAYS = 30;
const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
const MAX_CHUNKS_PER_SESSION = 2000;
const MAX_BYTES_PER_SESSION = 64 * 1024 * 1024;
const SID_RE = /^[a-f0-9]{32}$/;
const KEY_RE = /^[a-f0-9]{8}$/;

export function validateReplayParams(params) {
  const sid = params.get("s") || "";
  const key = params.get("k") || "";
  const seq = Number(params.get("q"));
  const clicks = Number(params.get("c") || 0);
  const path = (params.get("p") || "/").slice(0, 300);
  if (!SID_RE.test(sid)) return { error: "invalid session" };
  if (!KEY_RE.test(key)) return { error: "invalid page key" };
  if (!Number.isInteger(seq) || seq < 0 || seq > 99999) return { error: "invalid sequence" };
  if (!Number.isInteger(clicks) || clicks < 0 || clicks > 10000) return { error: "invalid clicks" };
  if (!path.startsWith("/")) return { error: "invalid path" };
  return { sid, key, seq, clicks, path, gzip: params.get("z") === "1" };
}

export async function handleReplayIngest(request, env, url, h) {
  const cors = await h.corsHeaders(request, env);
  if (!cors["Access-Control-Allow-Origin"]) return h.json({ error: "origin not allowed" }, 403);
  if (!env.REPLAYS) return h.json({ ok: true, ignored: "replay storage not configured" }, 202, cors);

  const site = h.normalizeDomain(url.searchParams.get("d"));
  if (!site || !h.DOMAIN_RE.test(site) || !(await h.allowedSites(env)).includes(site)) {
    return h.json({ error: "unknown site" }, 403, cors);
  }
  // The Origin header must belong to the site the chunk claims to be from.
  const originHost = h.normalizeDomain(new URL(request.headers.get("Origin")).hostname);
  if (originHost !== site && env.ALLOW_LOCAL_DEV !== "1") return h.json({ error: "site/origin mismatch" }, 400, cors);

  const p = validateReplayParams(url.searchParams);
  if (p.error) return h.json({ error: p.error }, 400, cors);

  const ua = request.headers.get("User-Agent") || "";
  if (h.looksLikeBot(ua)) return h.json({ ok: true, ignored: "bot" }, 202, cors);
  const cf = request.cf || {};
  if (h.isExcludedPlace(await h.excludedPlaces(env), cf)) return h.json({ ok: true, ignored: "place" }, 202, cors);

  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_CHUNK_BYTES) return h.json({ error: "chunk too large" }, 413, cors);
  const body = await request.arrayBuffer();
  if (!body.byteLength) return h.json({ error: "empty chunk" }, 400, cors);
  if (body.byteLength > MAX_CHUNK_BYTES) return h.json({ error: "chunk too large" }, 413, cors);
  if (!p.gzip && new Uint8Array(body)[0] !== 0x5b /* [ */) return h.json({ error: "chunk must be a JSON array" }, 400, cors);

  const existing = await env.DB.prepare("SELECT site, chunks, bytes FROM replay_sessions WHERE id = ?").bind(p.sid).first();
  if (existing && existing.site !== site) return h.json({ error: "invalid session" }, 400, cors);
  if (existing && (existing.chunks >= MAX_CHUNKS_PER_SESSION || existing.bytes >= MAX_BYTES_PER_SESSION)) {
    return h.json({ ok: true, ignored: "session limit reached" }, 202, cors);
  }

  const objectKey = `${site}/${p.sid}/${String(p.seq).padStart(5, "0")}-${p.key}`;
  await env.REPLAYS.put(objectKey, body, { customMetadata: { gzip: p.gzip ? "1" : "0" } });

  const now = Date.now();
  const client = h.parseUA(ua);
  const country = /^[A-Z]{2}$/.test(cf.country || "") ? cf.country : null;
  await env.DB.prepare(`INSERT INTO replay_sessions
      (id, site, started_at, last_at, pages, clicks, chunks, bytes, entry_path, last_path, country, browser, os, device)
    VALUES (?, ?, ?, ?, 1, ?, 1, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      last_at = MAX(replay_sessions.last_at, excluded.last_at),
      pages   = replay_sessions.pages + (CASE WHEN replay_sessions.last_path = excluded.last_path THEN 0 ELSE 1 END),
      clicks  = replay_sessions.clicks + excluded.clicks,
      chunks  = replay_sessions.chunks + 1,
      bytes   = replay_sessions.bytes + excluded.bytes,
      last_path = excluded.last_path
    WHERE replay_sessions.site = excluded.site`)
    .bind(p.sid, site, now, now, p.clicks, body.byteLength, p.path, p.path, country, client.browser, client.os, client.device)
    .run();

  return h.json({ ok: true }, 202, cors);
}

export async function handleReplayList(env, url, h) {
  const site = h.normalizeDomain(url.searchParams.get("site"));
  if (!site) return h.json({ error: "site is required" }, 400);
  const from = Number(url.searchParams.get("from")) * 1000 || 0;
  const to = Number(url.searchParams.get("to")) * 1000 || Date.now();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);
  const before = Number(url.searchParams.get("before")) || null; // pagination cursor: last_at
  const { results } = await env.DB.prepare(`SELECT id, started_at, last_at, pages, clicks, entry_path, last_path,
      country, browser, os, device
    FROM replay_sessions
    WHERE site = ? AND last_at >= ? AND started_at <= ? ${before ? "AND last_at < ?" : ""}
    ORDER BY last_at DESC LIMIT ?`)
    .bind(...[site, from, to, ...(before ? [before] : []), limit]).all();
  return h.json({ sessions: results || [], configured: Boolean(env.REPLAYS), retentionDays: RETENTION_DAYS });
}

export async function handleReplayGet(env, url, h) {
  const id = url.searchParams.get("id") || "";
  if (!SID_RE.test(id)) return h.json({ error: "invalid id" }, 400);
  if (!env.REPLAYS) return h.json({ error: "Replay storage (R2 binding REPLAYS) is not configured." }, 503);
  const session = await env.DB.prepare("SELECT * FROM replay_sessions WHERE id = ?").bind(id).first();
  if (!session) return h.json({ error: "Recording not found (it may have expired)." }, 404);

  const keys = await listKeys(env.REPLAYS, `${session.site}/${id}/`);
  keys.sort();
  const parts = [];
  for (const key of keys) {
    const obj = await env.REPLAYS.get(key);
    if (!obj) continue;
    const text = obj.customMetadata?.gzip === "1"
      ? await new Response(obj.body.pipeThrough(new DecompressionStream("gzip"))).text()
      : await obj.text();
    // Each chunk is a JSON array; splice them together without parsing.
    const inner = text.trim().slice(1, -1).trim();
    if (inner) parts.push(inner);
  }
  const body = `{"session":${JSON.stringify(session)},"events":[${parts.join(",")}]}`;
  return new Response(body, {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function listKeys(bucket, prefix) {
  const keys = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const o of page.objects) keys.push(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

/** Deletes sessions (rows + chunks) whose last activity is older than RETENTION_DAYS. */
export async function purgeExpiredReplays(env, now = Date.now()) {
  const cutoff = now - RETENTION_DAYS * 86400_000;
  let removed = 0;
  for (let round = 0; round < 20; round++) {
    const { results } = await env.DB.prepare("SELECT id, site FROM replay_sessions WHERE last_at < ? LIMIT 100").bind(cutoff).all();
    if (!results?.length) break;
    for (const row of results) {
      if (env.REPLAYS) {
        const keys = await listKeys(env.REPLAYS, `${row.site}/${row.id}/`);
        for (let i = 0; i < keys.length; i += 1000) await env.REPLAYS.delete(keys.slice(i, i + 1000));
      }
      await env.DB.prepare("DELETE FROM replay_sessions WHERE id = ?").bind(row.id).run();
      removed++;
    }
  }
  return removed;
}
