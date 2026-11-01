// End-to-end tests of the Worker against an in-memory SQLite stand-in for D1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import worker from '../src/worker.js';

const ORIGIN = 'https://t.test';
const M = 60000;
const T0 = Date.UTC(2026, 9, 31, 15, 0); // 10:00 Central
let clock = T0;
Date.now = () => clock;

function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const mk = (sql, args = []) => ({
    bind: (...a) => mk(sql, a.map(x => x === undefined ? null : x)),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { db.prepare(sql).run(...args); return { success: true }; },
    _run: () => db.prepare(sql).run(...args),
  });
  return {
    raw: db,
    prepare: (sql) => mk(sql),
    batch: async (stmts) => { for (const s of stmts) s._run(); return []; },
  };
}
const assets = {
  fetch: async (req) => {
    const f = path.join(new URL('../public', import.meta.url).pathname, new URL(req.url).pathname);
    if (!fs.existsSync(f)) return new Response('nope', { status: 404 });
    return new Response(fs.readFileSync(f), { headers: { 'content-type': 'text/plain' } });
  },
};
const env = { DB: makeD1(), ASSETS: assets, ADMIN_PASSCODE: 'correct horse', MA_PASSCODE: 'ma pass phrase', PUBLIC_URL: ORIGIN,
  FIREBASE_WEB_CONFIG: '{"apiKey":"k","projectId":"p"}', FIREBASE_VAPID_KEY: 'v' };

let sid = '';
const call = (method, p, body, { auth = true, origin = ORIGIN, xr = 'fetch', cookies = '' } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (origin) headers.origin = origin;
  if (xr) headers['x-requested-with'] = xr;
  const c = [auth && sid ? `sid=${sid}` : '', cookies].filter(Boolean).join('; ');
  if (c) headers.cookie = c;
  return worker.fetch(new Request(ORIGIN + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' }), env);
};
const j = async (r) => r.json();

test('pages carry security headers; protected pages redirect to login', async () => {
  const r = await call('GET', '/login', undefined, { auth: false });
  assert.equal(r.status, 200);
  for (const h of ['content-security-policy', 'x-frame-options', 'x-content-type-options', 'strict-transport-security', 'referrer-policy'])
    assert.ok(r.headers.get(h), h);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const home = await call('GET', '/', undefined, { auth: false });
  assert.equal(home.status, 302);
  assert.match(home.headers.get('location'), /\/login/);
});

test('login: wrong passcode rejected, right passcode sets hardened cookie', async () => {
  let r = await call('POST', '/api/login', { passcode: 'nope' }, { auth: false });
  assert.equal(r.status, 401);
  r = await call('POST', '/api/login', { passcode: 'correct horse' }, { auth: false });
  assert.equal(r.status, 200);
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Lax/); assert.match(sc, /Secure/);
  sid = /sid=([^;]+)/.exec(sc)[1];
  assert.ok(sid.length >= 30);
  // token itself is not stored, only its hash
  const rows = env.DB.raw.prepare('SELECT token_hash FROM sessions').all();
  assert.equal(rows.length, 1); assert.notEqual(rows[0].token_hash, sid);
});

test('CSRF: bad origin or missing header rejected; no session = 401', async () => {
  assert.equal((await call('POST', '/api/tap', { slug: 'x'.repeat(20) }, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await call('POST', '/api/tap', { slug: 'x'.repeat(20) }, { origin: null })).status, 403);
  assert.equal((await call('POST', '/api/tap', { slug: 'x'.repeat(20) }, { xr: null })).status, 403);
  assert.equal((await call('POST', '/api/tap', { slug: 'x'.repeat(20) }, { auth: false })).status, 401);
  assert.equal((await call('GET', '/api/summary', undefined, { auth: false })).status, 401);
  assert.equal((await call('POST', '/api/tags', { kind: 'room', label: 'x' }, { auth: false })).status, 401);
});

let slugs = {};
test('create tags and list URLs', async () => {
  for (const [kind, label] of [['room', 'Room 4'], ['room', 'Room 5'], ['dictation', 'Dictation'], ['endday', 'End of day'], ['survey', 'Survey']])
    assert.equal((await call('POST', '/api/tags', { kind, label })).status, 200);
  const list = await j(await call('GET', '/api/tags'));
  assert.equal(list.length, 5);
  for (const t of list) slugs[t.label] = /\/[ts]\/([^/]+)$/.exec(t.url)[1];
  assert.ok(Object.values(slugs).every(s => s.length >= 16));
  assert.equal((await call('POST', '/api/tags', { kind: 'bogus', label: 'x' })).status, 400);
});

const tap = async (label, minutes) => { clock = T0 + minutes * M; return j(await call('POST', '/api/tap', { slug: slugs[label] })); };

test('tap flow: in/out, dictation tied to room, forgotten tap-out inferred', async () => {
  assert.equal((await tap('Room 4', 0)).msg, 'In Room 4');
  let r = await tap('Room 4', 12);
  assert.equal(r.msg, 'Out of Room 4'); assert.equal(r.detail, '12 min');
  r = await tap('Dictation', 13);
  assert.equal(r.msg, 'Dictating (Room 4)');
  assert.equal((await tap('Room 5', 19)).msg, 'In Room 5');          // ends dictation
  assert.equal((await tap('Room 4', 80)).msg, 'In Room 4');          // forgot Room 5 out
  const rep = await tap('Room 4', 80);                               // duplicate within 5s
  assert.equal(rep.dup, true);
  const s = await j(await call('GET', '/api/summary?days=1'));
  const r4 = s.visits.find(v => v.room === 'Room 4' && v.room_min === 12);
  const r5 = s.visits.find(v => v.room === 'Room 5');
  assert.equal(r4.dict_min, 6);
  assert.equal(r5.status, 'review');                                 // 61 min inferred, over cutoff
  assert.equal(s.totals.counted, 1);
  assert.equal(s.totals.avg_room_min, 12);
  assert.equal(s.totals.avg_dict_min, 6);
  assert.equal(s.current.room, 'Room 4');
});

test('fix: validates, then makes the flagged visit count', async () => {
  const s = await j(await call('GET', '/api/summary?days=1'));
  const r5 = s.visits.find(v => v.room === 'Room 5');
  // 10:19 in; next tap is 11:20. 11:30 is too late, 10:10 is before entry
  assert.equal((await call('POST', '/api/fix', { startId: r5.inId, kind: 'room', time: '11:30' })).status, 400);
  assert.equal((await call('POST', '/api/fix', { startId: r5.inId, kind: 'room', time: '10:10' })).status, 400);
  assert.equal((await call('POST', '/api/fix', { startId: r5.inId, kind: 'room', time: 'abc' })).status, 400);
  assert.equal((await call('POST', '/api/fix', { startId: r5.inId, kind: 'room', time: '10:34' })).status, 200);
  const s2 = await j(await call('GET', '/api/summary?days=1'));
  const f = s2.visits.find(v => v.room === 'Room 5');
  assert.equal(f.room_min, 15); assert.equal(f.status, 'ok'); assert.equal(s2.totals.counted, 2);
  // an accurate, tap-recorded exit cannot be overwritten
  const r4 = s2.visits.find(v => v.room === 'Room 4' && v.room_min === 12);
  assert.equal((await call('POST', '/api/fix', { startId: r4.inId, kind: 'room', time: '10:05' })).status, 400);
});

test('end of day closes the open visit as inferred; unclosed visits stay out of averages', async () => {
  assert.equal((await tap('End of day', 200)).msg, 'Day closed');
  const s = await j(await call('GET', '/api/summary?days=1'));
  const last = s.visits.find(v => v.room === 'Room 4' && v.start !== undefined && v.room_min > 100);
  assert.equal(last.status, 'review');
  assert.equal(s.current, null);
});

test('reminder: sent once, only after the threshold', async () => {
  clock = T0 + 24 * 60 * M + 3 * 60 * M;          // next day 13:00
  const day2 = (m) => T0 + 24 * 60 * M + m * M;
  clock = day2(0); await j(await call('POST', '/api/tap', { slug: slugs['Room 5'] }));
  clock = day2(30); await worker.scheduled({}, env);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) c FROM reminders').get().c, 0);
  clock = day2(36); await worker.scheduled({}, env);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) c FROM reminders').get().c, 1);
  clock = day2(50); await worker.scheduled({}, env);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) c FROM reminders').get().c, 1);
});

test('push register validates input', async () => {
  assert.equal((await call('POST', '/api/push/register', { token: 'short' })).status, 400);
  assert.equal((await call('POST', '/api/push/register', { token: 't'.repeat(80) })).status, 200);
});

test('survey: public, radio-only, anonymous, rate-limited, hidden below threshold', async () => {
  clock = T0;
  const page = await call('GET', `/s/${slugs['Survey']}`, undefined, { auth: false });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /type="radio"/); assert.doesNotMatch(html, /<textarea|type="text"/);
  assert.equal((await call('GET', `/s/${slugs['Room 4']}`, undefined, { auth: false })).status, 404);   // not a survey tag
  const body = { slug: slugs['Survey'], answers: { q1: 5, q2: 4, q3: 3, q4: 5, q5: 4, junk: 9 } };
  let r = await call('POST', '/api/survey', body, { auth: false });
  assert.equal(r.status, 200);
  const svy = /svy=1/.test(r.headers.get('set-cookie'));
  assert.ok(svy);
  assert.equal((await call('POST', '/api/survey', body, { auth: false, cookies: 'svy=1' })).status, 429);
  assert.equal((await call('POST', '/api/survey', { slug: slugs['Survey'], answers: { q1: 99 } }, { auth: false })).status, 400);
  // the stored row has no room, no timestamp, no link to events
  const cols = env.DB.raw.prepare('PRAGMA table_info(survey_responses)').all().map(c => c.name);
  assert.deepEqual(cols.sort(), ['answers', 'half', 'id', 'month']);
  const row = env.DB.raw.prepare('SELECT * FROM survey_responses').get();
  assert.equal(row.month, '2026-10'); assert.equal(row.half, 'AM'); assert.deepEqual(JSON.parse(row.answers), { q1: 5, q2: 4, q3: 3, q4: 5, q5: 4 });
  let sum = await j(await call('GET', '/api/survey-summary'));
  assert.equal(sum.months[0].hidden, true);                       // 1 response < 5
  for (let i = 0; i < 4; i++) await call('POST', '/api/survey', { slug: slugs['Survey'], answers: { q1: 3, q2: 3 } }, { auth: false });
  sum = await j(await call('GET', '/api/survey-summary'));
  assert.equal(sum.months[0].n, 5);
  assert.equal(sum.months[0].q.q1, 3.4);                           // (5+3*4)/5
  assert.equal(sum.months[0].q.q3, null);                          // only 1 answer for q3, still hidden
  assert.equal((await call('GET', '/api/survey-summary', undefined, { auth: false })).status, 401);
});

test('tap and survey pages reject malformed slugs; unknown tags 404', async () => {
  assert.equal((await call('GET', '/t/short', undefined, { auth: false })).status, 404);
  assert.equal((await call('GET', '/t/' + 'a<script>'.padEnd(20, 'x'), undefined, { auth: false })).status, 404);
  assert.equal((await call('POST', '/api/tap', { slug: 'a'.repeat(24) })).status, 404);
});

test('static assets are served with headers; service worker injects config', async () => {
  const r = await call('GET', '/static/common.js', undefined, { auth: false });
  assert.equal(r.status, 200); assert.ok(r.headers.get('x-content-type-options'));
  const sw = await (await call('GET', '/firebase-messaging-sw.js', undefined, { auth: false })).text();
  assert.match(sw, /initializeApp\(\{"apiKey":"k"/);
});

test('a visit he is in right now is marked live', async () => {
  clock = T0 + 24 * 60 * M + 20 * M;                     // still inside the open Room 5 visit from the reminder test
  const s = await j(await call('GET', '/api/summary?days=1'));
  const open = s.visits.find(v => v.status === 'unclosed');
  assert.ok(open && open.live === true);
});

test('MA role: separate passcode, starts and clears waits, cannot see or change doctor data', async () => {
  const doctorSid = sid;
  const lr = await call('POST', '/api/login', { passcode: 'ma pass phrase' }, { auth: false });
  assert.equal(lr.status, 200);
  assert.equal((await j(lr)).role, 'ma');
  const maSid = /sid=([^;]+)/.exec(lr.headers.get('set-cookie'))[1];
  const D3 = T0 + 2 * 24 * 60 * M;                          // a fresh day with no events

  sid = maSid;
  // blocked from everything that belongs to the doctor
  assert.equal((await call('GET', '/api/summary?days=1')).status, 401);
  assert.equal((await call('GET', '/api/survey-summary')).status, 401);
  assert.equal((await call('GET', '/api/tags')).status, 401);
  assert.equal((await call('POST', '/api/tags', { kind: 'room', label: 'x' })).status, 403);
  assert.equal((await call('POST', '/api/fix', { startId: 1, kind: 'room', time: '10:00' })).status, 403);
  assert.equal((await call('POST', '/api/settings', { cutoffMin: 5 })).status, 403);
  assert.equal((await call('GET', '/', undefined, {})).status, 302);       // sent to the rooming page
  assert.equal((await call('GET', '/ma')).status, 200);

  // MA taps Room 4: a wait starts. Dictation and end-of-day cards do nothing for the MA.
  clock = D3;
  let r = await j(await call('POST', '/api/tap', { slug: slugs['Room 4'] }));
  assert.equal(r.msg, 'Room 4: patient waiting'); assert.equal(r.state, 'wait');
  assert.equal((await call('POST', '/api/tap', { slug: slugs['Dictation'] })).status, 400);
  assert.equal((await call('POST', '/api/tap', { slug: slugs['End of day'] })).status, 400);
  clock = D3 + 2000;
  assert.equal((await j(await call('POST', '/api/tap', { slug: slugs['Room 4'] }))).dup, true);  // double read ignored
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) c FROM events WHERE day='2026-11-02'").get().c, 0); // MA taps never touch his log
  clock = D3 + 12 * M;
  let w = await j(await call('GET', '/api/waiting'));
  assert.equal(w.waiting.length, 1); assert.equal(w.waiting[0].room, 'Room 4'); assert.equal(w.waiting[0].min, 12);

  // doctor sees the wait and tapping in ends it, recording how long he waited
  sid = doctorSid;
  w = await j(await call('GET', '/api/waiting'));
  assert.equal(w.waiting.length, 1);
  r = await j(await call('POST', '/api/tap', { slug: slugs['Room 4'] }));
  assert.equal(r.msg, 'In Room 4'); assert.equal(r.detail, 'waited 12 min');
  assert.equal((await j(await call('GET', '/api/waiting'))).waiting.length, 0);
  let s = await j(await call('GET', '/api/summary?days=1'));
  assert.equal(s.totals.avg_wait_min, 12); assert.equal(s.totals.waits_counted, 1);
  assert.equal(s.rooms.find(x => x.room === 'Room 4').avg_wait_min, 12);

  // his tap into a room nobody roomed adds no wait; MA tap again clears; MA can clear from the list
  clock = D3 + 20 * M;
  r = await j(await call('POST', '/api/tap', { slug: slugs['Room 5'] }));
  assert.equal(r.detail, null);
  sid = maSid; clock = D3 + 30 * M;
  await call('POST', '/api/tap', { slug: slugs['Room 5'] });
  clock = D3 + 40 * M;
  r = await j(await call('POST', '/api/tap', { slug: slugs['Room 5'] }));
  assert.equal(r.state, 'waitclear');
  await call('POST', '/api/tap', { slug: slugs['Room 5'] });          // waiting again
  clock = D3 + 50 * M;
  const id = (await j(await call('GET', '/api/waiting'))).waiting[0].id;
  assert.equal((await call('POST', '/api/waits/cancel', { id })).status, 200);
  assert.equal((await j(await call('GET', '/api/waiting'))).waiting.length, 0);

  // an old unanswered wait expires overnight and never counts
  clock = D3 + 60 * M;
  await call('POST', '/api/tap', { slug: slugs['Room 4'] });
  clock = D3 + 24 * 60 * M + 3 * 60 * M;
  await worker.scheduled({}, env);
  assert.equal(env.DB.raw.prepare("SELECT status FROM room_waits ORDER BY id DESC LIMIT 1").get().status, 'expired');

  // logging out the MA session leaves the doctor's session alone
  await call('POST', '/api/logout', {});
  assert.equal((await call('GET', '/api/waiting')).status, 401);
  sid = doctorSid;
  assert.equal((await call('GET', '/api/waiting')).status, 200);
});

test('login lockout after repeated failures', async () => {
  sid = '';
  let last;
  for (let i = 0; i < 11; i++) last = await call('POST', '/api/login', { passcode: 'bad' + i }, { auth: false });
  assert.equal(last.status, 429);
  // even the right passcode is refused while locked
  assert.equal((await call('POST', '/api/login', { passcode: 'correct horse' }, { auth: false })).status, 429);
});
