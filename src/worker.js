import {
  DEFAULTS, decideTap, computeVisits, summarize, validateFix, localTimeToMs,
  needsReminder, localDay, localMonth, halfOfDay,
} from './logic.js';
import { sendPush } from './fcm.js';

// ---------- Patient survey definition (radio buttons only, no free text) ----------
const SCALE = [
  [5, 'Strongly agree'], [4, 'Agree'], [3, 'Neutral'], [2, 'Disagree'], [1, 'Strongly disagree'],
];
const QUESTIONS = [
  { id: 'q1', text: 'I felt listened to.' },
  { id: 'q2', text: 'My doctor explained things clearly.' },
  { id: 'q3', text: 'I did not feel rushed.' },
  { id: 'q4', text: 'I was treated with respect.' },
  { id: 'q5', text: 'I would recommend this doctor to family or friends.' },
];

// ---------- helpers ----------
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const randToken = (n = 24) => {
  const a = crypto.getRandomValues(new Uint8Array(n));
  let s = ''; for (const b of a) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const SLUG_RE = /^[A-Za-z0-9_-]{16,64}$/;

async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let d = 0; for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

function secHeaders(extra = {}) {
  return {
    'content-security-policy': [
      "default-src 'none'",
      "script-src 'self' https://www.gstatic.com",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self' https://fcmregistrations.googleapis.com https://firebaseinstallations.googleapis.com https://fcm.googleapis.com https://www.googleapis.com",
      "manifest-src 'self'", "worker-src 'self'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
    ].join('; '),
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'cache-control': 'no-store',
    ...extra,
  };
}
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: secHeaders({ 'content-type': 'application/json', ...extra }) });

const shell = (title, mode, script, body, extraHead = '') => new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title}</title>
<link rel="manifest" href="/static/manifest.webmanifest">
<link rel="apple-touch-icon" href="/static/icon-180.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="theme-color" content="#0f4c5c">
<link rel="stylesheet" href="/static/app.css">${extraHead}</head>
<body data-mode="${mode}">${body}<script type="module" src="/static/${script}"></script></body></html>`,
  { headers: secHeaders({ 'content-type': 'text/html; charset=utf-8' }) });

async function getOpts(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key='opts'").first();
  let saved = {}; try { saved = row ? JSON.parse(row.value) : {}; } catch {}
  return { ...DEFAULTS, ...saved };
}

// ---------- auth ----------
function cookie(req, name) {
  const c = req.headers.get('cookie') || '';
  for (const part of c.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}
async function getSession(req, env) {
  const t = cookie(req, 'sid');
  if (!t || t.length < 20) return null;
  const row = await env.DB.prepare('SELECT expires, role FROM sessions WHERE token_hash=?').bind(await sha256(t)).first();
  return row && row.expires > Date.now() ? { role: row.role || 'doctor' } : null;
}
// doctor-only check used by every dashboard / admin route
async function isAuthed(req, env) {
  const s = await getSession(req, env);
  return !!s && s.role === 'doctor';
}
function sameOrigin(req, url) {
  const o = req.headers.get('origin');
  return o === url.origin && req.headers.get('x-requested-with') === 'fetch';
}
const setCookie = (url, name, val, maxAge) =>
  `${name}=${val}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${url.protocol === 'https:' ? '; Secure' : ''}`;

// ---------- data access ----------
async function lastEventToday(env, day) {
  return await env.DB.prepare('SELECT * FROM events WHERE day=? ORDER BY ts DESC, id DESC LIMIT 1').bind(day).first();
}
async function insertEvents(env, now, day, evs) {
  if (!evs.length) return;
  const st = env.DB.prepare('INSERT INTO events (ts, day, action, tag_id, room_label, inferred) VALUES (?,?,?,?,?,?)');
  await env.DB.batch(evs.map(e => st.bind(now, day, e.action, e.tag_id ?? null, e.room_label ?? null, e.inferred ? 1 : 0)));
}
function fmtDur(ms) {
  if (ms == null) return null;
  const m = Math.round(ms / 60000);
  return m < 1 ? '<1 min' : `${m} min`;
}

// ---------- routes ----------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      // static assets
      if (p.startsWith('/static/')) {
        const assetUrl = new URL(req.url);
        assetUrl.pathname = p.slice('/static'.length);
        const r = await env.ASSETS.fetch(new Request(assetUrl, { method: 'GET', headers: req.headers }));
        const h = new Headers(r.headers);
        for (const [k, v] of Object.entries(secHeaders({ 'cache-control': 'public, max-age=300' }))) h.set(k, v);
        return new Response(r.body, { status: r.status, headers: h });
      }
      if (p === '/firebase-messaging-sw.js') return serviceWorker(env);

      // pages
      if (req.method === 'GET') {
        if (p === '/login') return shell('Sign in', 'login', 'login.js',
          `<main class="card"><h1>Sign in</h1><form id="f"><label>Passcode<input id="pass" type="password" autocomplete="current-password" required></label>
          <button class="btn" type="submit">Sign in</button><p id="msg" class="msg"></p></form></main>`);

        let m = /^\/t\/([^/]+)$/.exec(p);
        if (m && SLUG_RE.test(m[1])) return shell('Tap', 'tap', 'tap.js',
          `<main class="card center"><div id="big" class="big">…</div><div id="sub" class="sub">Recording</div><a id="go" class="btn hidden" href="/login">Sign in</a></main>`.replace('<main', `<main data-slug="${m[1]}"`));

        m = /^\/s\/([^/]+)$/.exec(p);
        if (m && SLUG_RE.test(m[1])) return surveyPage(env, m[1]);

        if (p === '/ma' || p === '/' || p === '/fix' || p === '/admin') {
          const sess = await getSession(req, env);
          if (!sess) return Response.redirect(`${url.origin}/login?next=${encodeURIComponent(p)}`, 302);
          if (p === '/ma') return shell('Rooming', 'ma', 'ma.js', MA_BODY);
          if (sess.role !== 'doctor') return Response.redirect(`${url.origin}/ma`, 302);
          if (p === '/admin') return shell('Setup', 'admin', 'admin.js', ADMIN_BODY);
          return shell(p === '/fix' ? 'Fix times' : 'Room time', p === '/fix' ? 'fix' : 'dash', 'dash.js', DASH_BODY);
        }
        if (p === '/api/config' && (await isAuthed(req, env))) {
          return json({ firebase: safeJson(env.FIREBASE_WEB_CONFIG), vapidKey: env.FIREBASE_VAPID_KEY || '' });
        }
        if (p === '/api/waiting') {
          if (!(await getSession(req, env))) return json({ error: 'auth' }, 401);
          return waitingList(env);
        }
        if (p === '/api/summary') return needAuth(req, env, () => summary(env, url));
        if (p === '/api/survey-summary') return needAuth(req, env, () => surveySummary(env));
        if (p === '/api/tags') return needAuth(req, env, () => listTags(env, url));
        if (p === '/api/settings') return needAuth(req, env, async () => json(await getOpts(env)));
        return new Response('Not found', { status: 404, headers: secHeaders() });
      }

      // all state-changing calls
      if (req.method === 'POST') {
        if (!sameOrigin(req, url)) return json({ error: 'bad origin' }, 403);
        if (p === '/api/login') return login(req, env, url);
        if (p === '/api/survey') return submitSurvey(req, env, url);
        const sess = await getSession(req, env);
        if (!sess) return json({ error: 'auth' }, 401);
        if (p === '/api/logout') return logout(req, env, url);
        if (p === '/api/tap') return tap(req, env, sess);
        if (p === '/api/waits/cancel') return cancelWait(req, env);
        if (sess.role !== 'doctor') return json({ error: 'forbidden' }, 403);   // the MA role stops here
        if (p === '/api/fix') return fix(req, env);
        if (p === '/api/tags') return createTag(req, env);
        if (p === '/api/tags/disable') return disableTag(req, env);
        if (p === '/api/settings') return saveSettings(req, env);
        if (p === '/api/push/register') return registerPush(req, env);
      }
      return new Response('Not found', { status: 404, headers: secHeaders() });
    } catch (e) {
      console.error('error', e && e.message);
      return json({ error: 'server error' }, 500);
    }
  },

  // once a minute: send one reminder if he has been in a visit/dictation too long
  async scheduled(_event, env) {
    const opts = await getOpts(env);
    const now = Date.now();
    await env.DB.prepare('DELETE FROM sessions WHERE expires < ?').bind(now).run();
    await env.DB.prepare('DELETE FROM login_fails WHERE ts < ?').bind(now - 3600000).run();
    await env.DB.prepare("UPDATE room_waits SET status='expired' WHERE status='waiting' AND day < ?").bind(localDay(now, opts.timezone)).run();
    const last = await env.DB.prepare('SELECT * FROM events ORDER BY ts DESC, id DESC LIMIT 1').first();
    if (!last) return;
    const done = await env.DB.prepare('SELECT 1 FROM reminders WHERE event_id=?').bind(last.id).first();
    const remindedIds = new Set(done ? [last.id] : []);
    if (!needsReminder({ last, now, remindedIds, opts })) return;
    await env.DB.prepare('INSERT OR IGNORE INTO reminders (event_id, sent_at) VALUES (?,?)').bind(last.id, now).run();
    const toks = (await env.DB.prepare('SELECT token FROM push_tokens').all()).results.map(r => r.token);
    const what = last.action === 'DICT' ? 'Still dictating?' : 'Still in a visit?';
    const { dead } = await sendPush(env, toks, {
      title: what, body: 'Tap to set your actual time.', link: `${env.PUBLIC_URL}/fix`,
    });
    for (const t of dead) await env.DB.prepare('DELETE FROM push_tokens WHERE token=?').bind(t).run();
  },
};

const safeJson = (s) => { try { return JSON.parse(s); } catch { return {}; } };
async function needAuth(req, env, fn) {
  if (!(await isAuthed(req, env))) return json({ error: 'auth' }, 401);
  return fn();
}

// ---------- login ----------
async function login(req, env, url) {
  const now = Date.now();
  const fails = await env.DB.prepare('SELECT COUNT(*) AS c FROM login_fails WHERE ts > ?').bind(now - 15 * 60000).first();
  if (fails.c >= 10) return json({ error: 'Too many attempts. Wait 15 minutes.' }, 429);
  let body = {}; try { body = await req.json(); } catch {}
  const pass = typeof body.passcode === 'string' ? body.passcode : '';
  let role = null;
  if (pass && env.ADMIN_PASSCODE && (await safeEqual(pass, env.ADMIN_PASSCODE))) role = 'doctor';
  else if (pass && env.MA_PASSCODE && (await safeEqual(pass, env.MA_PASSCODE))) role = 'ma';
  if (!role) {
    await env.DB.prepare('INSERT INTO login_fails (ts) VALUES (?)').bind(now).run();
    return json({ error: 'Wrong passcode' }, 401);
  }
  const token = randToken(32);
  const maxAge = 60 * 60 * 24 * 365;
  await env.DB.prepare('INSERT INTO sessions (token_hash, expires, role) VALUES (?,?,?)').bind(await sha256(token), now + maxAge * 1000, role).run();
  return json({ ok: true, role }, 200, { 'set-cookie': setCookie(url, 'sid', token, maxAge) });
}
async function logout(req, env, url) {
  const t = cookie(req, 'sid');
  if (t) await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256(t)).run();
  return json({ ok: true }, 200, { 'set-cookie': setCookie(url, 'sid', '', 0) });
}

// ---------- tap ----------
async function tap(req, env, sess) {
  let b = {}; try { b = await req.json(); } catch {}
  if (typeof b.slug !== 'string' || !SLUG_RE.test(b.slug)) return json({ error: 'bad tag' }, 400);
  const tag = await env.DB.prepare('SELECT id, kind, label, active FROM tags WHERE slug=?').bind(b.slug).first();
  if (!tag || !tag.active) return json({ error: 'Unknown or disabled tag' }, 404);
  if (tag.kind === 'survey') return json({ error: 'This is a patient tag' }, 400);
  const opts = await getOpts(env);
  const now = Date.now();
  const day = localDay(now, opts.timezone);
  if (sess.role === 'ma') return maTap(env, tag, now, day, opts);
  const last = await lastEventToday(env, day);
  const r = decideTap({ last, tag, now, dupMs: opts.dupMs });
  await insertEvents(env, now, day, r.events);
  let detail = null;
  if (r.state === 'in' && tag.kind === 'room') {          // he walked in: the patient's wait ends here
    const waited = await closeWait(env, tag.id, now, day);
    if (waited != null) detail = 'waited ' + fmtDur(waited);
  }
  if (r.state === 'out' && last) detail = fmtDur(now - last.ts);
  if (r.state === 'dict_end' && last) detail = fmtDur(now - last.ts);
  return json({ ok: true, msg: r.msg, state: r.state || null, dup: !!r.dup, detail });
}

// ---------- MA rooming and waits ----------
async function maTap(env, tag, now, day, opts) {
  if (tag.kind !== 'room') return json({ error: 'The MA role only uses room cards' }, 400);
  const w = await env.DB.prepare("SELECT id, start_ts FROM room_waits WHERE room_tag_id=? AND day=? AND status='waiting' ORDER BY start_ts DESC LIMIT 1").bind(tag.id, day).first();
  if (w && now - w.start_ts < opts.dupMs) return json({ ok: true, msg: 'Already recorded', state: 'dup', dup: true, detail: null });
  if (w) {
    await env.DB.prepare("UPDATE room_waits SET status='cancelled', end_ts=? WHERE id=?").bind(now, w.id).run();
    return json({ ok: true, msg: `${tag.label}: wait cleared`, state: 'waitclear', dup: false, detail: null });
  }
  await env.DB.prepare('INSERT INTO room_waits (room_tag_id, room_label, day, start_ts) VALUES (?,?,?,?)').bind(tag.id, tag.label, day, now).run();
  return json({ ok: true, msg: `${tag.label}: patient waiting`, state: 'wait', dup: false, detail: null });
}
async function closeWait(env, tagId, now, day) {
  const w = await env.DB.prepare("SELECT id, start_ts FROM room_waits WHERE room_tag_id=? AND day=? AND status='waiting' ORDER BY start_ts DESC LIMIT 1").bind(tagId, day).first();
  if (!w) return null;
  await env.DB.prepare("UPDATE room_waits SET status='seen', end_ts=? WHERE id=?").bind(now, w.id).run();
  return now - w.start_ts;
}
async function waitingList(env) {
  const opts = await getOpts(env);
  const now = Date.now();
  const rows = (await env.DB.prepare("SELECT id, room_label, start_ts FROM room_waits WHERE day=? AND status='waiting' ORDER BY start_ts").bind(localDay(now, opts.timezone)).all()).results;
  const t = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: opts.timezone, hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
  return json({ waiting: rows.map(r => ({ id: r.id, room: r.room_label, since: t(r.start_ts), min: Math.floor((now - r.start_ts) / 60000) })) });
}
async function cancelWait(req, env) {
  let b = {}; try { b = await req.json(); } catch {}
  const id = Number(b.id);
  if (!Number.isInteger(id)) return json({ error: 'bad request' }, 400);
  await env.DB.prepare("UPDATE room_waits SET status='cancelled', end_ts=? WHERE id=? AND status='waiting'").bind(Date.now(), id).run();
  return json({ ok: true });
}

// ---------- summary ----------
async function summary(env, url) {
  const opts = await getOpts(env);
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '1', 10) || 1, 1), 366);
  const now = Date.now();
  const today = localDay(now, opts.timezone);
  const from = localDay(now - (days - 1) * 86400000, opts.timezone);
  const rows = (await env.DB.prepare('SELECT * FROM events WHERE day>=? AND day<=? ORDER BY ts, id').bind(from, today).all()).results;
  const { visits, orphans } = computeVisits(rows, opts);
  const tz = opts.timezone;
  const t = (ms) => ms == null ? null : new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
  const lastRow = rows.at(-1) || null;   // a visit he is in right now is "live", not "unclosed"
  const isLiveRoom = (v) => !!lastRow && lastRow.action === 'IN' && lastRow.id === v.id;
  const isLiveDict = (v) => !!lastRow && lastRow.action === 'DICT' && v.dictStart === lastRow.ts && v.room === lastRow.room_label && v.dictEnd == null;
  const out = visits.map(v => ({
    inId: v.id, day: v.day, room: v.room, start: t(v.start), end: t(v.end),
    room_min: v.roomMs == null ? null : Math.round(v.roomMs / 60000),
    dict_min: v.dictMs == null ? null : Math.round(v.dictMs / 60000),
    dictOpen: v.dictStart != null && v.dictEnd == null,
    live: isLiveRoom(v), dictLive: isLiveDict(v),
    dictStartId: null, status: v.status, dictCounted: v.dictCounted, inferred: v.inferred, fixed: v.fixed,
  }));
  // attach DICT start ids so the UI can fix dictation end times
  const dictIds = new Map();
  for (const e of rows) if (e.action === 'DICT') dictIds.set(`${e.day}|${e.room_label}|${e.ts}`, e.id);
  visits.forEach((v, i) => { if (v.dictStart != null) out[i].dictStartId = dictIds.get(`${v.day}|${v.room}|${v.dictStart}`) ?? null; });

  const s = summarize(visits);
  const waitRows = (await env.DB.prepare("SELECT room_label, start_ts, end_ts FROM room_waits WHERE status='seen' AND day>=? AND day<=?").bind(from, today).all()).results
    .filter(w => w.end_ts - w.start_ts <= 240 * 60000);
  const waitBy = {}; let waitSum = 0;
  for (const w of waitRows) { const x = (waitBy[w.room_label] ||= { n: 0, ms: 0 }); x.n++; x.ms += w.end_ts - w.start_ts; waitSum += w.end_ts - w.start_ts; }
  const byRoom = {};
  for (const v of visits) {
    const r = (byRoom[v.room] ||= { room: v.room, n: 0, roomMs: 0, nDict: 0, dictMs: 0 });
    if (v.counted) { r.n++; r.roomMs += v.roomMs; }
    if (v.dictCounted) { r.nDict++; r.dictMs += v.dictMs; }
  }
  const rooms = Object.values(byRoom).map(r => ({
    room: r.room, n: r.n, avg_room_min: r.n ? Math.round(r.roomMs / r.n / 60000 * 10) / 10 : null,
    avg_dict_min: r.nDict ? Math.round(r.dictMs / r.nDict / 60000 * 10) / 10 : null,
    avg_wait_min: waitBy[r.room] ? Math.round(waitBy[r.room].ms / waitBy[r.room].n / 6000) / 10 : null,
  })).sort((a, b) => String(a.room).localeCompare(String(b.room), undefined, { numeric: true }));
  const last = rows.at(-1) || null;
  return json({
    days, today, visits: out.reverse(),
    totals: {
      visits: s.visits, counted: s.counted, needReview: s.needReview,
      avg_room_min: s.avgRoomMs == null ? null : Math.round(s.avgRoomMs / 6000) / 10,
      avg_dict_min: s.avgDictMs == null ? null : Math.round(s.avgDictMs / 6000) / 10,
      total_room_min: Math.round(s.totalRoomMs / 60000), total_dict_min: Math.round(s.totalDictMs / 60000),
      orphanDictations: orphans.length,
      avg_wait_min: waitRows.length ? Math.round(waitSum / waitRows.length / 6000) / 10 : null,
      waits_counted: waitRows.length,
    },
    rooms,
    current: last && (last.action === 'IN' || last.action === 'DICT') && last.day === today
      ? { action: last.action, room: last.room_label, since: t(last.ts) } : null,
    settings: { cutoffMin: opts.cutoffMin, remindMin: opts.remindMin },
  });
}

// ---------- fix an end time ----------
async function fix(req, env) {
  let b = {}; try { b = await req.json(); } catch {}
  const startId = Number(b.startId);
  const kind = b.kind === 'dict' ? 'dict' : 'room';
  if (!Number.isInteger(startId)) return json({ error: 'bad request' }, 400);
  const startAction = kind === 'dict' ? 'DICT' : 'IN';
  const endAction = kind === 'dict' ? 'DICT_END' : 'OUT';
  const start = await env.DB.prepare('SELECT * FROM events WHERE id=? AND action=?').bind(startId, startAction).first();
  if (!start) return json({ error: 'not found' }, 404);
  const opts = await getOpts(env);
  const newOut = localTimeToMs(start.day, String(b.time || ''), opts.timezone);
  const after = (await env.DB.prepare(
    'SELECT * FROM events WHERE day=? AND (ts>? OR (ts=? AND id>?)) ORDER BY ts, id LIMIT 3'
  ).bind(start.day, start.ts, start.ts, start.id).all()).results;
  const first = after[0];
  const existing = first && first.action === endAction ? first : null;
  if (existing && !existing.inferred && !existing.fixed) return json({ error: 'That one was recorded by a tap and is already correct.' }, 400);
  const nextMs = existing ? (after[1] ? after[1].ts : null) : (first ? first.ts : null);
  const err = validateFix({ inMs: start.ts, nextMs, newOut, nowMs: Date.now() });
  if (err) return json({ error: err }, 400);
  if (existing) {
    await env.DB.prepare('UPDATE events SET ts=?, fixed=1 WHERE id=?').bind(newOut, existing.id).run();
  } else {
    await env.DB.prepare('INSERT INTO events (ts, day, action, tag_id, room_label, inferred, fixed) VALUES (?,?,?,?,?,0,1)')
      .bind(newOut, start.day, endAction, start.tag_id, start.room_label).run();
  }
  return json({ ok: true });
}

// ---------- tags / settings / push ----------
async function listTags(env, url) {
  const rows = (await env.DB.prepare('SELECT id, slug, kind, label, active FROM tags ORDER BY kind, label').all()).results;
  return json(rows.map(r => ({ id: r.id, kind: r.kind, label: r.label, active: !!r.active,
    url: `${url.origin}/${r.kind === 'survey' ? 's' : 't'}/${r.slug}` })));
}
async function createTag(req, env) {
  let b = {}; try { b = await req.json(); } catch {}
  const kind = ['room', 'dictation', 'endday', 'survey'].includes(b.kind) ? b.kind : null;
  const label = typeof b.label === 'string' ? b.label.trim().slice(0, 40) : '';
  if (!kind || !label) return json({ error: 'kind and label required' }, 400);
  const id = randToken(9), slug = randToken(18);
  await env.DB.prepare('INSERT INTO tags (id, slug, kind, label, created_at) VALUES (?,?,?,?,?)').bind(id, slug, kind, label, Date.now()).run();
  return json({ ok: true });
}
async function disableTag(req, env) {
  let b = {}; try { b = await req.json(); } catch {}
  await env.DB.prepare('UPDATE tags SET active=0 WHERE id=?').bind(String(b.id || '')).run();
  return json({ ok: true });
}
async function saveSettings(req, env) {
  let b = {}; try { b = await req.json(); } catch {}
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : d; };
  const cur = await getOpts(env);
  const next = {
    cutoffMin: num(b.cutoffMin, 5, 240, cur.cutoffMin),
    dictCutoffMin: num(b.dictCutoffMin, 5, 240, cur.dictCutoffMin),
    remindMin: num(b.remindMin, 10, 180, cur.remindMin),
    clinicStartHour: num(b.clinicStartHour, 0, 23, cur.clinicStartHour),
    clinicEndHour: num(b.clinicEndHour, 1, 24, cur.clinicEndHour),
    minSurveyN: num(b.minSurveyN, 3, 50, cur.minSurveyN),
  };
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('opts', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(JSON.stringify(next)).run();
  return json({ ok: true });
}
async function registerPush(req, env) {
  let b = {}; try { b = await req.json(); } catch {}
  const t = typeof b.token === 'string' ? b.token : '';
  if (t.length < 20 || t.length > 4096) return json({ error: 'bad token' }, 400);
  await env.DB.prepare('INSERT OR IGNORE INTO push_tokens (token, created_at) VALUES (?,?)').bind(t, Date.now()).run();
  return json({ ok: true });
}

// ---------- patient survey ----------
async function surveyPage(env, slug) {
  const tag = await env.DB.prepare("SELECT kind, active FROM tags WHERE slug=?").bind(slug).first();
  if (!tag || !tag.active || tag.kind !== 'survey') return new Response('Not found', { status: 404, headers: secHeaders() });
  const qs = QUESTIONS.map(q => `<fieldset data-q="${q.id}"><legend>${q.text}</legend>${SCALE.map(([v, l]) =>
    `<label class="opt"><input type="radio" name="${q.id}" value="${v}"><span>${l}</span></label>`).join('')}</fieldset>`).join('');
  return shell('Quick feedback', 'survey', 'survey.js',
    `<main class="card" data-slug="${slug}"><h1>Quick feedback</h1>
    <p class="note">Optional and anonymous. Your answers are not linked to your name, your chart or the time of your visit.
    We keep only the month and whether it was morning or afternoon. Please choose one answer per line.</p>
    <form id="f">${qs}<button class="btn" type="submit">Send</button><p id="msg" class="msg"></p></form></main>`);
}
async function submitSurvey(req, env, url) {
  if (cookie(req, 'svy')) return json({ error: 'Thanks, we already got your answers.' }, 429);
  let b = {}; try { b = await req.json(); } catch {}
  if (typeof b.slug !== 'string' || !SLUG_RE.test(b.slug)) return json({ error: 'bad request' }, 400);
  const tag = await env.DB.prepare("SELECT kind, active FROM tags WHERE slug=?").bind(b.slug).first();
  if (!tag || !tag.active || tag.kind !== 'survey') return json({ error: 'Not found' }, 404);
  const answers = {};
  for (const q of QUESTIONS) {
    const v = Number(b.answers && b.answers[q.id]);
    if (Number.isInteger(v) && v >= 1 && v <= 5) answers[q.id] = v;
  }
  if (!Object.keys(answers).length) return json({ error: 'Please answer at least one question.' }, 400);
  const opts = await getOpts(env);
  const now = Date.now();
  await env.DB.prepare('INSERT INTO survey_responses (month, half, answers) VALUES (?,?,?)')
    .bind(localMonth(now, opts.timezone), halfOfDay(now, opts.timezone), JSON.stringify(answers)).run();
  return json({ ok: true }, 200, { 'set-cookie': setCookie(url, 'svy', '1', 1800) });
}
async function surveySummary(env) {
  const opts = await getOpts(env);
  const rows = (await env.DB.prepare('SELECT month, half, answers FROM survey_responses').all()).results;
  const byMonth = {};
  for (const r of rows) {
    const m = (byMonth[r.month] ||= { month: r.month, n: 0, q: {} });
    m.n++;
    let a = {}; try { a = JSON.parse(r.answers); } catch {}
    for (const q of QUESTIONS) if (a[q.id]) { const x = (m.q[q.id] ||= { sum: 0, n: 0 }); x.sum += a[q.id]; x.n++; }
  }
  let hidden = 0;
  const months = Object.values(byMonth).sort((a, b) => b.month.localeCompare(a.month)).map(m => {
    if (m.n < opts.minSurveyN) { hidden += m.n; return { month: m.month, hidden: true, n: null }; }
    const q = {};
    for (const x of QUESTIONS) { const v = m.q[x.id]; q[x.id] = v && v.n >= opts.minSurveyN ? Math.round(v.sum / v.n * 100) / 100 : null; }
    return { month: m.month, n: m.n, q };
  });
  return json({ questions: QUESTIONS, months, minN: opts.minSurveyN, hiddenResponses: hidden });
}

// ---------- service worker for FCM (config injected so it never sits in a static file) ----------
function serviceWorker(env) {
  const cfg = JSON.stringify(safeJson(env.FIREBASE_WEB_CONFIG));
  const js = `importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js','https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');
firebase.initializeApp(${cfg});
const messaging = firebase.messaging();
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));`;
  return new Response(js, { headers: { 'content-type': 'application/javascript', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

// ---------- static page bodies ----------
const DASH_BODY = `<header class="bar"><h1 id="title">Room time</h1><nav><a href="/">Today</a><a href="/fix">Fix</a><a href="/admin">Setup</a></nav></header>
<main>
<section id="waiting" class="card waiting hidden"></section>
<section id="now" class="card hidden"></section>
<section class="card"><div class="seg" id="range"><button data-d="1" class="on">Today</button><button data-d="7">7 days</button><button data-d="30">30 days</button></div>
<div id="stats" class="stats"></div></section>
<section class="card" id="attn-card"><h2>Needs your attention</h2><p class="note">Visits closed by a later tap, or never closed, are left out of the averages until you set the real time.</p><div id="attn"></div></section>
<section class="card" id="rooms-card"><h2>By room</h2><div id="rooms"></div></section>
<section class="card" id="visits-card"><h2>Visits</h2><div id="visits"></div></section>
<section class="card" id="survey-card"><h2>Patient feedback</h2><div id="survey"></div></section>
<section class="card" id="push-card"><h2>Reminders</h2><p class="note">Get a nudge if a visit or dictation runs long. On iPhone this only works from the Home Screen app.</p><button class="btn" id="push">Turn on reminders</button><p id="pushmsg" class="msg"></p></section>
<p class="foot"><button class="link" id="logout">Sign out</button></p>
</main>`;
const ADMIN_BODY = `<header class="bar"><h1>Setup</h1><nav><a href="/">Today</a><a href="/fix">Fix</a><a href="/admin">Setup</a></nav></header>
<main>
<section class="card"><h2>Add a tag</h2><form id="tagform">
<label>Type<select id="kind"><option value="room">Room (tap in / out)</option><option value="dictation">Dictation area</option><option value="endday">End of day</option><option value="survey">Patient survey</option></select></label>
<label>Name<input id="label" maxlength="40" placeholder="Room 4" required></label>
<button class="btn" type="submit">Create tag</button><p id="tagmsg" class="msg"></p></form></section>
<section class="card"><h2>Tags</h2><p class="note">Write each URL to its NFC sticker with a free app such as NFC Tools. Put the same URL in a QR code for survey tags.</p><div id="tags"></div></section>
<section class="card"><h2>Rules</h2><form id="setform">
<label>Ignore averages for auto-closed visits longer than (min)<input id="cutoffMin" type="number" min="5" max="240"></label>
<label>Same for dictation (min)<input id="dictCutoffMin" type="number" min="5" max="240"></label>
<label>Send a reminder after (min)<input id="remindMin" type="number" min="10" max="180"></label>
<label>Reminders start (hour, 24h)<input id="clinicStartHour" type="number" min="0" max="23"></label>
<label>Reminders stop (hour, 24h)<input id="clinicEndHour" type="number" min="1" max="24"></label>
<label>Hide survey results until at least this many responses<input id="minSurveyN" type="number" min="3" max="50"></label>
<button class="btn" type="submit">Save</button><p id="setmsg" class="msg"></p></form></section>
</main>`;

const MA_BODY = `<header class="bar"><h1>Rooming</h1></header>
<main>
<section class="card"><h2>Patients waiting</h2>
<p class="note">Tap a room's card with this phone when you put a patient in that room. Tap the same card again to clear it. The doctor sees the list and the wait time.</p>
<div id="list"></div></section>
<p class="foot"><button class="link" id="logout">Sign out</button></p>
</main>`;
