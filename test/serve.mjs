// Dev-only preview: runs the Worker on node:http with an in-memory SQLite stand-in for D1.
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import worker from '../src/worker.js';

const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
const mk = (sql, args = []) => ({
  bind: (...a) => mk(sql, a.map(x => x === undefined ? null : x)),
  first: async () => db.prepare(sql).get(...args) ?? null,
  all: async () => ({ results: db.prepare(sql).all(...args) }),
  run: async () => { db.prepare(sql).run(...args); return {}; }, _run: () => db.prepare(sql).run(...args),
});
const D1 = { prepare: (s) => mk(s), batch: async (ss) => { for (const s of ss) s._run(); } };
const pub = new URL('../public', import.meta.url).pathname;
const ASSETS = { fetch: async (req) => {
  const f = path.join(pub, new URL(req.url).pathname);
  if (!fs.existsSync(f)) return new Response('nope', { status: 404 });
  const ct = f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : f.endsWith('.png') ? 'image/png' : 'application/manifest+json';
  return new Response(fs.readFileSync(f), { headers: { 'content-type': ct } });
} };
const port = Number(process.env.PORT || 8787);
const env = { DB: D1, ASSETS, ADMIN_PASSCODE: 'demo-pass', PUBLIC_URL: `http://localhost:${port}`, FIREBASE_WEB_CONFIG: '{}', FIREBASE_VAPID_KEY: '' };

http.createServer(async (rq, rs) => {
  const chunks = []; for await (const c of rq) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const req = new Request(`http://localhost:${port}${rq.url}`, { method: rq.method, headers: rq.headers, body: ['GET', 'HEAD'].includes(rq.method) ? undefined : body, redirect: 'manual' });
  const res = await worker.fetch(req, env);
  const h = {}; res.headers.forEach((v, k) => { h[k] = v; });
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (sc.length) h['set-cookie'] = sc;
  rs.writeHead(res.status, h); rs.end(Buffer.from(await res.arrayBuffer()));
}).listen(port, () => console.log('listening', port));
