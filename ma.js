import { api, el, clear } from './common.js';
const list = document.getElementById('list');
async function load() {
  const r = await api('/api/waiting');
  if (r.status === 401) { location.replace('/login?next=/ma'); return; }
  clear(list);
  const w = r.data.waiting || [];
  if (!w.length) { list.append(el('p', { class: 'note' }, 'No one is marked as waiting.')); return; }
  for (const x of w) {
    list.append(el('div', { class: 'waitrow' }, el('strong', {}, x.room), el('span', { class: 'pill' }, x.min + ' min'),
      el('span', { class: 'note grow' }, 'roomed ' + x.since),
      el('button', { class: 'btn small ghost', type: 'button', onclick: async () => { await api('/api/waits/cancel', { id: x.id }); load(); } }, 'Clear')));
  }
}
document.getElementById('logout').addEventListener('click', async () => { await api('/api/logout', {}); location.replace('/login'); });
load(); setInterval(() => { if (!document.hidden) load(); }, 10000);
