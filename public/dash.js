import { api, el, clear } from './common.js';
const mode = document.body.dataset.mode;
let days = mode === 'fix' ? 7 : 1;
const $ = (id) => document.getElementById(id);

if (mode === 'fix') {
  $('title').textContent = 'Fix times';
  for (const id of ['rooms-card', 'visits-card', 'survey-card', 'push-card']) $(id).classList.add('hidden');
  $('range').parentElement.classList.add('hidden');
}
for (const b of document.querySelectorAll('#range button')) {
  b.addEventListener('click', () => {
    document.querySelectorAll('#range button').forEach(x => x.classList.remove('on'));
    b.classList.add('on'); days = Number(b.dataset.d); load();
  });
}
const fmt = (m) => m == null ? '–' : (m >= 60 ? `${Math.floor(m / 60)}h ${Math.round(m % 60)}m` : `${Math.round(m * 10) / 10} min`);
const stat = (label, val) => el('div', { class: 'stat' }, el('div', { class: 'v' }, val), el('div', { class: 'l' }, label));

function fixRow(kind, startId, label, hint) {
  const t = el('input', { type: 'time', required: '' });
  const msg = el('span', { class: 'msg' });
  const form = el('form', { class: 'row fixrow' }, el('div', { class: 'grow' }, el('strong', {}, label), el('div', { class: 'note' }, hint)),
    el('label', { class: 'inl' }, kind === 'dict' ? 'Dictation ended at' : 'I left at', t),
    el('button', { class: 'btn small', type: 'submit' }, 'Save'), msg);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await api('/api/fix', { startId, kind, time: t.value });
    if (r.ok) load(); else msg.textContent = r.data.error || 'Error';
  });
  return form;
}

async function load() {
  const r = await api('/api/summary?days=' + days);
  if (r.status === 401) { location.replace('/login?next=' + encodeURIComponent(location.pathname)); return; }
  const d = r.data, t = d.totals;
  // now
  const now = $('now');
  if (d.current && mode !== 'fix') {
    now.classList.remove('hidden'); clear(now);
    now.append(el('strong', {}, d.current.action === 'IN' ? `In ${d.current.room} since ${d.current.since}` : `Dictating${d.current.room ? ' (' + d.current.room + ')' : ''} since ${d.current.since}`));
  } else now.classList.add('hidden');
  // stats
  const s = clear($('stats'));
  s.append(stat('Visits counted', `${t.counted}`), stat('Avg in room', fmt(t.avg_room_min)),
    stat('Avg dictation', fmt(t.avg_dict_min)), stat('Total in rooms', fmt(t.total_room_min)), stat('Total dictating', fmt(t.total_dict_min)));
  // attention
  const attn = clear($('attn')); let n = 0;
  for (const v of d.visits) {
    if (v.status === 'review' || v.status === 'unclosed') {
      n++; attn.append(fixRow('room', v.inId, `${v.room} · ${v.day} · in at ${v.start}`,
        v.status === 'unclosed' ? 'Never closed. When did you leave?' : 'Closed by a later tap. When did you actually leave?'));
    }
    if (v.dict_min != null && !v.dictCounted && v.dictStartId) {
      n++; attn.append(fixRow('dict', v.dictStartId, `Dictation after ${v.room} · ${v.day}`, 'Dictation ran long before the next tap. When did it end?'));
    } else if (v.dictOpen && v.dictStartId && !(d.current && d.current.action === 'DICT' && d.today === v.day && v === d.visits[0])) {
      n++; attn.append(fixRow('dict', v.dictStartId, `Dictation after ${v.room} · ${v.day}`, 'Never ended. When did it end?'));
    }
  }
  if (!n) attn.append(el('p', { class: 'note' }, 'Nothing to fix.'));
  if (mode === 'fix') return;
  // rooms
  const rooms = clear($('rooms'));
  if (!d.rooms.length) rooms.append(el('p', { class: 'note' }, 'No visits yet.'));
  else {
    const tb = el('table', {}, el('thead', {}, el('tr', {}, ...['Room', 'Visits', 'Avg in room', 'Avg dictation'].map(h => el('th', {}, h)))));
    const body = el('tbody');
    for (const x of d.rooms) body.append(el('tr', {}, el('td', {}, x.room), el('td', {}, x.n), el('td', {}, fmt(x.avg_room_min)), el('td', {}, fmt(x.avg_dict_min))));
    tb.append(body); rooms.append(tb);
  }
  // visits
  const vs = clear($('visits'));
  if (!d.visits.length) vs.append(el('p', { class: 'note' }, 'Nothing logged for this range.'));
  else {
    const tb = el('table', {}, el('thead', {}, el('tr', {}, ...['Day', 'Room', 'In', 'Out', 'Room', 'Dictation', ''].map(h => el('th', {}, h)))));
    const body = el('tbody');
    for (const v of d.visits.slice(0, 200)) {
      const flag = v.status === 'review' ? 'check' : v.status === 'unclosed' ? 'open' : (v.fixed ? 'fixed' : '');
      body.append(el('tr', { class: flag ? 'flag' : '' }, el('td', {}, v.day.slice(5)), el('td', {}, v.room), el('td', {}, v.start || ''), el('td', {}, v.end || ''),
        el('td', {}, v.room_min == null ? '–' : v.room_min + 'm'), el('td', {}, v.dict_min == null ? (v.dictOpen ? 'open' : '–') : v.dict_min + 'm'), el('td', {}, flag)));
    }
    tb.append(body); vs.append(tb);
  }
  loadSurvey();
}

async function loadSurvey() {
  const r = await api('/api/survey-summary');
  const box = clear($('survey'));
  if (!r.ok) return;
  const d = r.data;
  if (!d.months.length) { box.append(el('p', { class: 'note' }, 'No responses yet.')); return; }
  box.append(el('p', { class: 'note' }, `Averages (1–5, higher is better). A month appears once it has ${d.minN}+ responses, so no single patient can be picked out.`));
  const tb = el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Month'), el('th', {}, 'n'), ...d.questions.map(q => el('th', { title: q.text }, q.id.toUpperCase())))));
  const body = el('tbody');
  for (const m of d.months) {
    if (m.hidden) body.append(el('tr', { class: 'flag' }, el('td', {}, m.month), el('td', { colspan: String(d.questions.length + 1) }, 'Not enough responses yet')));
    else body.append(el('tr', {}, el('td', {}, m.month), el('td', {}, m.n), ...d.questions.map(q => el('td', {}, m.q[q.id] == null ? '–' : m.q[q.id]))));
  }
  tb.append(body); box.append(tb);
  box.append(el('ul', { class: 'legend' }, ...d.questions.map(q => el('li', {}, `${q.id.toUpperCase()}: ${q.text}`))));
}

// push
const pushBtn = $('push');
if (pushBtn) pushBtn.addEventListener('click', async () => {
  const msg = $('pushmsg'); msg.textContent = '';
  try {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) throw new Error('Open this from the Home Screen app first (Share > Add to Home Screen).');
    const perm = await Notification.requestPermission();   // must run straight from the tap
    if (perm !== 'granted') throw new Error('Notifications were not allowed.');
    const cfg = (await api('/api/config')).data;
    if (!cfg.firebase || !cfg.firebase.apiKey || !cfg.vapidKey) throw new Error('Firebase is not set up on the server yet.');
    const reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
    await navigator.serviceWorker.ready;
    const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js');
    const { getMessaging, getToken } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging.js');
    const messaging = getMessaging(initializeApp(cfg.firebase));
    const token = await getToken(messaging, { vapidKey: cfg.vapidKey, serviceWorkerRegistration: reg });
    if (!token) throw new Error('Could not get a notification token.');
    const r = await api('/api/push/register', { token });
    msg.textContent = r.ok ? 'Reminders are on for this phone.' : 'Could not save.';
  } catch (e) { msg.textContent = e.message || 'Could not turn on reminders.'; }
});
const lo = $('logout');
if (lo) lo.addEventListener('click', async () => { await api('/api/logout', {}); location.replace('/login'); });
load();
