import { api } from './common.js';
const slug = document.querySelector('main').dataset.slug;
const big = document.getElementById('big'), sub = document.getElementById('sub'), go = document.getElementById('go');
(async () => {
  const r = await api('/api/tap', { slug });
  if (r.status === 401) {
    big.textContent = 'Sign in'; sub.textContent = 'This phone is not signed in yet.';
    go.href = '/login?next=' + encodeURIComponent('/t/' + slug); go.classList.remove('hidden');
    document.body.classList.add('s-warn'); return;
  }
  if (!r.ok) { big.textContent = 'Not recorded'; sub.textContent = r.data.error || 'Try again'; document.body.classList.add('s-warn'); return; }
  big.textContent = r.data.msg;
  const t = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  sub.textContent = (r.data.detail ? r.data.detail + ' · ' : '') + t;
  document.body.classList.add('s-' + (r.data.state || 'dup'));
})();
