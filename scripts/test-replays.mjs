// Session replay regression tests: ingest → list → fetch → purge, through the
// real worker router, against in-memory SQLite (schema.sql) and a fake R2.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import * as replays from '../src/replays.js';

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
const statement = (sql, binds) => ({
  async all() { return { results: db.prepare(sql).all(...binds) }; },
  async first() { return db.prepare(sql).get(...binds) || null; },
  async run() { return db.prepare(sql).run(...binds); },
});
const DB = { prepare(sql) { return { bind: (...b) => statement(sql, b), ...statement(sql, []) }; }, async batch(s) { return Promise.all(s.map((x) => x.run())); } };

const objects = new Map();
const REPLAYS = {
  async put(key, body, opts) { objects.set(key, { bytes: new Uint8Array(body), meta: opts?.customMetadata || {} }); },
  async get(key) {
    const o = objects.get(key); if (!o) return null;
    return { customMetadata: o.meta, body: new Blob([o.bytes]).stream(), text: async () => new TextDecoder().decode(o.bytes) };
  },
  async list({ prefix }) { return { objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }; },
  async delete(keys) { for (const k of [].concat(keys)) objects.delete(k); },
};

const context = vm.createContext({ URL, Request, Response, Headers, Blob, atob, TextEncoder, crypto: globalThis.crypto, ...replays });
vm.runInContext(readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8')
  .replace(/^import .*$/m, '').replace('export default {', 'var worker = {'), context);

const env = { DB, REPLAYS, DASH_PASSWORD: 'local-test-only', ALLOWED_SITES: 'example.test,other.test' };
const auth = 'Basic ' + Buffer.from('admin:local-test-only').toString('base64');
const UA = 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36';
const SID = 'a'.repeat(32);
let checks = 0;
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };

async function ingest(query, body, { origin = 'https://example.test', gzip = false } = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  const res = await context.worker.fetch(new Request('https://lucid.test/replay?' + new URLSearchParams(query) + (gzip ? '&z=1' : ''), {
    method: 'POST', headers: { Origin: origin, 'User-Agent': UA }, body: gzip ? gzipSync(raw) : raw,
  }), env, {});
  return { status: res.status, body: await res.json() };
}
async function get(path, authed = true) {
  const res = await context.worker.fetch(new Request('https://lucid.test' + path, { headers: authed ? { Authorization: auth } : {} }), env, {});
  let body; try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

const q = (over = {}) => ({ d: 'example.test', s: SID, k: '0123abcd', q: '0', p: '/', c: '0', ...over });
const meta = (t, href) => ({ type: 4, timestamp: t, data: { href, width: 1200, height: 800 } });
const click = (t, id) => ({ type: 3, timestamp: t, data: { source: 2, type: 2, id, x: 1, y: 1 } });
const full = (t) => ({ type: 2, timestamp: t, data: { node: { type: 0, childNodes: [], id: 1 }, initialOffset: { top: 0, left: 0 } } });

// 1. valid chunks: gzip first page, plain-JSON second page
eq((await ingest(q({ c: '1' }), [meta(1000, 'https://example.test/'), full(1001), click(1500, 7)], { gzip: true })).status, 202);
eq((await ingest(q({ q: '1', p: '/pricing', c: '2' }), [meta(3000, 'https://example.test/pricing'), full(3001), click(3500, 9), click(3600, 9)])).status, 202);
const row = db.prepare('SELECT * FROM replay_sessions WHERE id=?').get(SID);
eq([row.site, row.pages, row.clicks, row.chunks, row.entry_path, row.last_path, row.browser, row.device],
  ['example.test', 2, 3, 2, '/', '/pricing', 'Chrome', 'Desktop'], 'session summary aggregates chunks');
eq(objects.size, 2, 'both chunks stored in R2');

// 2. rejected uploads write nothing
const before = objects.size;
eq((await ingest(q(), [full(1)], { origin: 'https://evil.test' })).status, 403, 'foreign origin');
eq((await ingest(q({ d: 'other.test' }), [full(1)])).status, 400, 'site/origin mismatch');
eq((await ingest(q({ d: 'unknown.test' }), [full(1)], { origin: 'https://unknown.test' })).status, 403, 'unregistered site');
eq((await ingest(q({ s: 'not-a-session' }), [full(1)])).status, 400, 'bad session id');
eq((await ingest(q({ k: 'zz' }), [full(1)])).status, 400, 'bad page key');
eq((await ingest(q({ q: '-1' }), [full(1)])).status, 400, 'bad sequence');
eq((await ingest(q(), { not: 'an array' })).status, 400, 'non-array body');
eq((await ingest(q({ d: 'other.test' }), [full(1)], { origin: 'https://other.test' })).status, 400, 'session id owned by another site');
eq(objects.size, before, 'rejected uploads stored nothing');

// 3. bots are ignored
const bot = await context.worker.fetch(new Request('https://lucid.test/replay?' + new URLSearchParams(q({ q: '5' })), {
  method: 'POST', headers: { Origin: 'https://example.test', 'User-Agent': 'Googlebot/2.1' }, body: '[]' }), env, {});
eq((await bot.json()).ignored, 'bot');

// 4. private endpoints need the password
eq((await get('/api/replays?site=example.test', false)).status, 401);
eq((await get('/api/replay?id=' + SID, false)).status, 401);

// 5. list + fetch
const list = await get('/api/replays?site=example.test&from=0&to=' + (Math.floor(Date.now() / 1000) + 10));
eq([list.status, list.body.configured, list.body.sessions.length, list.body.sessions[0].id], [200, true, 1, SID]);
eq((await get('/api/replays?site=other.test')).body.sessions.length, 0, 'sites are isolated');
const rec = await get('/api/replay?id=' + SID);
eq(rec.status, 200);
eq(rec.body.events.map((e) => e.timestamp), [1000, 1001, 1500, 3000, 3001, 3500, 3600], 'gzip + plain chunks merged in order');
eq((await get('/api/replay?id=' + 'b'.repeat(32))).status, 404);
eq((await get('/api/replay?id=../../x')).status, 400);

// 6. tracker endpoint for the recorder is public
const assets = { fetch: async (req) => new Response('/*rrweb*/', { status: new URL(req.url).pathname === '/vendor/rrweb-record.min.js' ? 200 : 404 }) };
const script = await context.worker.fetch(new Request('https://lucid.test/replay-recorder.js'), { ...env, ASSETS: assets }, {});
eq([script.status, script.headers.get('Content-Type').startsWith('application/javascript')], [200, true]);

// 7. without R2 configured, ingest is a no-op and the list says so
const noR2 = { ...env, REPLAYS: undefined };
const off = await context.worker.fetch(new Request('https://lucid.test/replay?' + new URLSearchParams(q({ q: '9' })), {
  method: 'POST', headers: { Origin: 'https://example.test', 'User-Agent': UA }, body: '[]' }), noR2, {});
eq(off.status, 202);

// 8. purge removes sessions past retention, keeps recent ones
db.prepare("INSERT INTO replay_sessions (id,site,started_at,last_at,pages,clicks,chunks,bytes) VALUES (?, 'example.test', 0, 0, 1, 0, 1, 1)").run('c'.repeat(32));
await REPLAYS.put('example.test/' + 'c'.repeat(32) + '/00000-0123abcd', new TextEncoder().encode('[]'));
eq(await replays.purgeExpiredReplays(env), 1);
eq(db.prepare('SELECT id FROM replay_sessions').all().map((r) => r.id), [SID]);
eq([...objects.keys()].some((k) => k.includes('c'.repeat(32))), false, 'expired chunks deleted');

console.log('Session replay tests passed: ' + checks + '.');
