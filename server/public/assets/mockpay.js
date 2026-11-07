import { h, api, clear, $ } from './common.js';

const id = location.pathname.split('/').pop();
const app = $('#app');
try {
  const p = await api(`/api/public/mock/${id}`);
  const form = (result, label, cls) =>
    h('form', { method: 'POST', action: `/api/webhooks/mock/${id}` },
      h('input', { type: 'hidden', name: 'result', value: result }),
      h('button', { class: `btn ${cls}`, type: 'submit' }, label));
  clear(app).append(
    h('div', { class: 'card stack' },
      h('h1', {}, 'Test payment'),
      h('p', { class: 'muted' }, `This is a fake payment page for testing. ${p.name} would receive Rs ${p.amount}.`),
      form('success', 'Simulate successful payment', 'primary'),
      form('fail', 'Simulate failed payment', 'danger'))
  );
} catch (e) {
  clear(app).append(h('div', { class: 'notice bad' }, e.message));
}
