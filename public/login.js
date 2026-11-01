import { api } from './common.js';
const f = document.getElementById('f'), msg = document.getElementById('msg');
f.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.textContent = '';
  const r = await api('/api/login', { passcode: document.getElementById('pass').value });
  if (!r.ok) { msg.textContent = r.data.error || 'Could not sign in'; return; }
  let next = new URLSearchParams(location.search).get('next') || '/';
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) next = '/';
  location.replace(next);
});
