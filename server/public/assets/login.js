import { h, api, clear, $, store, toast } from './common.js';

const app = $('#app');
let mode = 'in';

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function render() {
  const err = h('div', { class: 'notice bad hidden', role: 'alert' });
  const fail = (m) => { err.textContent = m; err.classList.remove('hidden'); };
  const f = {};
  const input = (name, label, type = 'text', extra = {}) => {
    f[name] = h('input', { type, id: name, autocomplete: extra.autocomplete, required: true, ...extra });
    return h('div', { class: 'field' }, h('label', { for: name }, label), f[name]);
  };

  const body = mode === 'in'
    ? [input('email', 'Email', 'email', { autocomplete: 'username' }), input('password', 'Password', 'password', { autocomplete: 'current-password' })]
    : [
        input('shopName', 'Shop name'),
        input('slug', 'Shop link'),
        h('p', { class: 'small muted', id: 'slugHint' }, ''),
        h('div', { class: 'grid2' }, input('city', 'City'), input('phone', 'Phone', 'tel')),
        input('email', 'Email', 'email', { autocomplete: 'username' }),
        input('password', 'Password (8+ characters)', 'password', { autocomplete: 'new-password', minlength: 8 }),
      ];

  const form = h('form', { class: 'stack', novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      err.classList.add('hidden');
      try {
        const v = (k) => f[k].value.trim();
        const r = mode === 'in'
          ? await api('/api/auth/login', { method: 'POST', json: { email: v('email'), password: f.password.value } })
          : await api('/api/auth/signup', { method: 'POST', json: { shopName: v('shopName'), slug: v('slug'), city: v('city'), phone: v('phone'), email: v('email'), password: f.password.value } });
        store.set('shopToken', r.token);
        location.href = '/dashboard';
      } catch (x) { fail(x.message); }
    } },
    ...body, err,
    h('button', { class: 'btn primary', type: 'submit' }, mode === 'in' ? 'Sign in' : 'Create my shop'));

  clear(app).append(
    h('h1', {}, mode === 'in' ? 'Shop sign in' : 'Create your shop'),
    h('div', { class: 'card' }, form),
    h('p', { class: 'muted', style: 'margin-top:14px' },
      mode === 'in' ? 'New here? ' : 'Already have a shop? ',
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); mode = mode === 'in' ? 'up' : 'in'; render(); } }, mode === 'in' ? 'Create your shop' : 'Sign in'))
  );

  if (mode === 'up') {
    const hint = $('#slugHint');
    const upd = () => { hint.textContent = f.slug.value ? `Customers will open: ${location.origin}/s/${f.slug.value}` : ''; };
    f.shopName.addEventListener('input', () => { if (!f.slug.dataset.touched) { f.slug.value = slugify(f.shopName.value); upd(); } });
    f.slug.addEventListener('input', () => { f.slug.dataset.touched = '1'; upd(); });
  }
}

if (store.get('shopToken')) location.href = '/dashboard';
else render();
