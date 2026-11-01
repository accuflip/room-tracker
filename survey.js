import { api } from './common.js';
const main = document.querySelector('main'), slug = main.dataset.slug;
const f = document.getElementById('f'), msg = document.getElementById('msg');
f.addEventListener('submit', async (e) => {
  e.preventDefault();
  const answers = {};
  for (const fs of f.querySelectorAll('fieldset')) {
    const c = fs.querySelector('input:checked');
    if (c) answers[fs.dataset.q] = Number(c.value);
  }
  if (!Object.keys(answers).length) { msg.textContent = 'Please pick at least one answer.'; return; }
  const r = await api('/api/survey', { slug, answers });
  if (r.ok) { main.replaceChildren(Object.assign(document.createElement('h1'), { textContent: 'Thank you' }),
    Object.assign(document.createElement('p'), { textContent: 'Your feedback was received. You can close this page.' })); }
  else msg.textContent = r.data.error || 'Could not send. Please try again.';
});
