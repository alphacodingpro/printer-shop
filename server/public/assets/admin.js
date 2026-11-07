import { h, api, clear, $, store, toast, money, fmtTime } from './common.js';

const app = $('#app');
let token = store.get('adminToken');
const call = (path, opts = {}) =>
  api('/api/admin' + path, { ...opts, token }).catch((e) => {
    if (e.status === 401) { store.del('adminToken'); token = null; login(); }
    throw e;
  });
const act = async (fn, msg) => { try { await fn(); if (msg) toast(msg); return true; } catch (e) { toast(e.message, true); return false; } };

function login() {
  const email = h('input', { type: 'email', autocomplete: 'username' });
  const pw = h('input', { type: 'password', autocomplete: 'current-password' });
  const err = h('div', { class: 'notice bad hidden' });
  clear(app).append(h('main', { class: 'wrap' }, h('h1', {}, 'Platform admin'),
    h('form', { class: 'card stack', onsubmit: async (e) => {
      e.preventDefault();
      try { token = (await api('/api/auth/admin/login', { method: 'POST', json: { email: email.value, password: pw.value } })).token; store.set('adminToken', token); main(); }
      catch (x) { err.textContent = x.message; err.classList.remove('hidden'); }
    } }, h('div', { class: 'field' }, h('label', {}, 'Email'), email), h('div', { class: 'field' }, h('label', {}, 'Password'), pw), err, h('button', { class: 'btn primary', type: 'submit' }, 'Sign in'))));
}

async function main() {
  if (!token) return login();
  const [stats, shops, plans] = await Promise.all([call('/stats'), call('/shops'), call('/plans')]);
  const stat = (n, l) => h('div', { class: 'stat' }, h('b', {}, n), h('span', { class: 'muted small' }, l));

  const shopRow = (s) => {
    const status = h('select', { onchange: async (e) => (await act(() => call(`/shops/${s.id}`, { method: 'PATCH', json: { status: e.target.value } }), 'Saved')) },
      ['pending', 'active', 'suspended'].map((v) => h('option', { value: v, selected: s.status === v }, v)));
    const plan = h('select', {}, plans.map((p) => h('option', { value: p.id, selected: p.id === s.plan_id }, p.name)));
    const sub = h('select', {}, ['trialing', 'active', 'past_due', 'cancelled'].map((v) => h('option', { value: v, selected: s.sub_status === v }, v)));
    const end = h('input', { type: 'date', value: s.current_period_end ? new Date(s.current_period_end).toISOString().slice(0, 10) : '' });
    return h('tr', {},
      h('td', {}, h('strong', {}, s.name), h('div', { class: 'muted small' }, `/s/${s.slug}`), h('div', { class: 'muted small' }, s.owner_email)),
      h('td', {}, s.city ?? '', h('div', { class: 'muted small' }, s.phone ?? '')),
      h('td', { class: 'num' }, s.orders, h('div', { class: 'muted small' }, fmtTime(s.created_at))),
      h('td', {}, status),
      h('td', {}, h('div', { class: 'row', style: 'gap:6px' }, plan, sub, end,
        h('button', { class: 'btn small', onclick: () => act(() => call(`/shops/${s.id}/subscription`, { method: 'PUT', json: { planId: plan.value, status: sub.value, periodEnd: new Date(end.value + 'T23:59:59Z').toISOString() } }), 'Saved') }, 'Save'))));
  };

  const np = { name: h('input', { type: 'text', placeholder: 'Plan name' }), price: h('input', { type: 'number', placeholder: 'Rs / month' }), printers: h('input', { type: 'number', placeholder: 'Max printers', value: 1 }), orders: h('input', { type: 'number', placeholder: 'Orders / month (blank = unlimited)' }) };

  clear(app).append(
    h('header', { class: 'top' }, h('div', { class: 'in' }, h('strong', {}, 'PrintSaaS admin'), h('button', { class: 'btn small', onclick: () => { store.del('adminToken'); location.reload(); } }, 'Sign out'))),
    h('main', { class: 'wrap wide' },
      h('div', { class: 'stats' }, stat(stats.shops, 'Shops'), stat(stats.pending_shops, 'Waiting for approval'), stat(stats.orders_30d, 'Orders (30 days)'), stat(money(stats.gross_30d), 'Paid by customers (30 days)')),
      h('section', { class: 'card tablewrap' }, h('h2', {}, 'Shops'),
        h('table', {}, h('thead', {}, h('tr', {}, ['Shop', 'Contact', 'Orders', 'Status', 'Plan, subscription, paid until'].map((x) => h('th', {}, x)))), h('tbody', {}, shops.map(shopRow)))),
      h('section', { class: 'card tablewrap' }, h('h2', {}, 'Plans'),
        h('table', {}, h('thead', {}, h('tr', {}, ['Plan', 'Rs / month', 'Printers', 'Orders / month', 'Active'].map((x) => h('th', {}, x)))),
          h('tbody', {}, plans.map((p) => h('tr', {}, h('td', {}, p.name), h('td', { class: 'num' }, p.price_monthly), h('td', { class: 'num' }, p.max_printers), h('td', { class: 'num' }, p.max_orders_per_month ?? 'Unlimited'),
            h('td', {}, h('input', { type: 'checkbox', checked: p.is_active, onchange: (e) => act(() => call(`/plans/${p.id}`, { method: 'PUT', json: { isActive: e.target.checked, maxOrdersPerMonth: p.max_orders_per_month } }), 'Saved') })))))),
        h('h3', { style: 'margin-top:14px' }, 'Add a plan'),
        h('div', { class: 'grid2' }, np.name, np.price, np.printers, np.orders),
        h('div', { style: 'margin-top:10px' }, h('button', { class: 'btn primary', onclick: async () => (await act(() => call('/plans', { method: 'POST', json: { name: np.name.value, priceMonthly: np.price.value, maxPrinters: np.printers.value, maxOrdersPerMonth: np.orders.value } }), 'Plan added')) && main() }, 'Add plan')))));
}

main().catch((e) => { if (e.status !== 401) clear(app).append(h('main', { class: 'wrap' }, h('div', { class: 'notice bad' }, e.message))); });
