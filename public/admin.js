import { api, el, clear } from './common.js';
const tagsDiv = document.getElementById('tags');
const KIND = { room: 'Room', dictation: 'Dictation', endday: 'End of day', survey: 'Patient survey' };
async function loadTags() {
  const r = await api('/api/tags');
  clear(tagsDiv);
  if (!r.data.length) tagsDiv.append(el('p', { class: 'note' }, 'No tags yet.'));
  for (const t of r.data) {
    const row = el('div', { class: 'tagrow' + (t.active ? '' : ' off') },
      el('div', {}, el('strong', {}, t.label), ' ', el('span', { class: 'pill' }, KIND[t.kind] + (t.active ? '' : ' (off)'))),
      el('code', {}, t.url));
    const btns = el('div', { class: 'row' });
    btns.append(el('button', { class: 'btn small', onclick: async (e) => { await navigator.clipboard.writeText(t.url); e.target.textContent = 'Copied'; } }, 'Copy URL'));
    if (t.active) btns.append(el('button', { class: 'btn small ghost', onclick: async () => {
      if (confirm('Turn off this tag? Past records are kept.')) { await api('/api/tags/disable', { id: t.id }); loadTags(); } } }, 'Turn off'));
    row.append(btns); tagsDiv.append(row);
  }
}
document.getElementById('tagform').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('tagmsg');
  const r = await api('/api/tags', { kind: document.getElementById('kind').value, label: document.getElementById('label').value });
  msg.textContent = r.ok ? 'Created' : (r.data.error || 'Error');
  if (r.ok) { document.getElementById('label').value = ''; loadTags(); }
});
const KEYS = ['cutoffMin', 'dictCutoffMin', 'remindMin', 'clinicStartHour', 'clinicEndHour', 'minSurveyN'];
(async () => {
  const s = (await api('/api/settings')).data;
  for (const k of KEYS) document.getElementById(k).value = s[k];
})();
document.getElementById('setform').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {}; for (const k of KEYS) body[k] = document.getElementById(k).value;
  const r = await api('/api/settings', body);
  document.getElementById('setmsg').textContent = r.ok ? 'Saved' : (r.data.error || 'Error');
});
loadTags();
