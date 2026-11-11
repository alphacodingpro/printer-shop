import { h, api, clear, $, store, toast, money, fmtTime } from './common.js';

const app = $('#app');
let token = store.get('adminToken');
const S = { tab: 'overview', shopId: null, shops: [], search: '', state: '', plans: [] };

const call = (path, opts = {}) =>
  api('/api/admin' + path, { ...opts, token }).catch((e) => {
    if (e.status === 401) { store.del('adminToken'); token = null; login(); }
    throw e;
  });
const act = async (fn, msg) => {
  try { const r = await fn(); if (msg) toast(msg); return r ?? true; } catch (e) { toast(e.message, true); return false; }
};

const STATE = {
  trial: ['Free trial', 'info'], paid: ['Paid', 'ok'], expired: ['Expired', 'bad'], pending: ['Waiting for approval', 'warn'],
  suspended: ['Suspended', 'bad'], past_due: ['Payment late', 'warn'], cancelled: ['Cancelled', ''], none: ['No plan', ''],
};
const chip = (state) => h('span', { class: `chip ${STATE[state]?.[1] ?? ''}` }, STATE[state]?.[0] ?? state);
const plural = (n, w) => `${n} ${w}${Math.abs(n) === 1 ? '' : 's'}`;
function daysText(s) {
  if (s.days_left == null || ['pending', 'suspended', 'none'].includes(s.state)) return '';
  if (s.state === 'expired') return s.days_left >= 0 ? 'ended today' : `ended ${plural(-s.days_left, 'day')} ago`;
  return `${plural(s.days_left, 'day')} left`;
}
const dateOnly = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const field = (label, input, hint) => h('div', { class: 'field' }, h('label', {}, label), input, hint && h('div', { class: 'small muted' }, hint));

// ------------------------------------------------------------------ login
function login() {
  const email = h('input', { type: 'email', autocomplete: 'username' });
  const pw = h('input', { type: 'password', autocomplete: 'current-password' });
  const err = h('div', { class: 'notice bad hidden', role: 'alert' });
  clear(app).append(h('main', { class: 'wrap' }, h('h1', {}, 'Platform admin'),
    h('form', { class: 'card stack', onsubmit: async (e) => {
      e.preventDefault();
      try { token = (await api('/api/auth/admin/login', { method: 'POST', json: { email: email.value, password: pw.value } })).token; store.set('adminToken', token); main(); }
      catch (x) { err.textContent = x.message; err.classList.remove('hidden'); }
    } }, field('Email', email), field('Password', pw), err, h('button', { class: 'btn primary', type: 'submit' }, 'Sign in'))));
}

// ------------------------------------------------------------------ shell
const TABS = [['overview', 'Overview'], ['shops', 'Shops'], ['plans', 'Plans'], ['settings', 'Settings'], ['activity', 'Activity']];

async function main() {
  if (!token) return login();
  try {
    S.shops = await call('/shops');
    S.plans = await call('/plans');
  } catch (e) { if (e.status !== 401) clear(app).append(h('main', { class: 'wrap' }, h('div', { class: 'notice bad' }, e.message))); return; }
  show();
}

async function show() {
  const pending = S.shops.filter((s) => s.state === 'pending').length;
  clear(app).append(
    h('header', { class: 'top' },
      h('div', { class: 'in' }, h('strong', {}, 'PrintSaaS admin'), h('button', { class: 'btn small', onclick: () => { store.del('adminToken'); location.reload(); } }, 'Sign out')),
      h('nav', { class: 'tabs', role: 'tablist' }, TABS.map(([k, label]) =>
        h('button', { role: 'tab', 'aria-selected': S.tab === k && !S.shopId ? 'true' : 'false', onclick: () => { S.tab = k; S.shopId = null; show(); } },
          label, k === 'shops' && pending ? h('span', { class: 'badge', title: 'Waiting for approval' }, pending) : null)))),
    h('main', { class: 'wrap wide', id: 'content' }));
  const c = $('#content');
  try {
    if (S.shopId) await shopView(c);
    else await ({ overview: overviewView, shops: shopsView, plans: plansView, settings: settingsView, activity: activityView }[S.tab])(c);
  } catch (e) { if (e.status !== 401) clear(c).append(h('div', { class: 'notice bad' }, e.message)); }
}

async function reload() {
  S.shops = await call('/shops');
  S.plans = await call('/plans');
  await show();
}
const openShop = (id) => { S.shopId = id; show(); };

// ------------------------------------------------------------------ overview
async function overviewView(c) {
  const o = await call('/overview');
  const stat = (n, label) => h('div', { class: 'stat' }, h('b', {}, n), h('span', { class: 'muted small' }, label));
  const quick = (label, fn, cls = '') => h('button', { class: `btn small ${cls}`, onclick: async (e) => { e.stopPropagation(); if (await act(fn)) reload(); } }, label);
  const extend = (id, days, markPaid = false) => () => call(`/shops/${id}/extend`, { method: 'POST', json: { days, markPaid } });

  const list = (title, rows, empty, buttons) => h('section', { class: 'card' }, h('h2', {}, title, rows.length ? h('span', { class: 'badge' }, rows.length) : null),
    rows.length ? h('div', { class: 'lines' }, rows.map((s) => h('div', {},
      h('div', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); openShop(s.id); } }, h('strong', {}, s.name)), h('div', { class: 'muted small' }, `${s.owner_email ?? ''} · /s/${s.slug}`)),
      h('div', { class: 'row', style: 'gap:6px' }, h('span', { class: 'muted small' }, daysText(s) || `joined ${dateOnly(s.created_at)}`), ...buttons(s)))))
      : h('p', { class: 'muted', style: 'margin:0' }, empty));

  clear(c).append(
    h('div', { class: 'stats' },
      stat(o.total, 'Shops'), stat(o.counts.trial ?? 0, 'On free trial'), stat(o.counts.paid ?? 0, 'Paid'), stat(o.counts.expired ?? 0, 'Expired'),
      stat(o.counts.pending ?? 0, 'Waiting for approval'), stat(o.counts.suspended ?? 0, 'Suspended'), stat(o.new_shops_7d, 'New shops (7 days)'),
      stat(o.orders_30d, 'Orders (30 days)'), stat(money(o.gross_30d), 'Paid by customers (30 days)')),
    list('Waiting for approval', o.attention.pending, 'No shops are waiting.', (s) => [quick('Approve', () => call(`/shops/${s.id}`, { method: 'PATCH', json: { status: 'active' } })), quick('Open', () => openShop(s.id))]),
    list('Free trial ends within 7 days', o.attention.endingSoon, 'No trials are about to end.', (s) => [quick('+7 days', extend(s.id, 7)), quick('Mark paid +30 days', extend(s.id, 30, true))]),
    list('Expired: closed to customers', o.attention.expired, 'No expired shops.', (s) => [quick('+7 days trial', extend(s.id, 7)), quick('Mark paid +30 days', extend(s.id, 30, true))]));
}

// ------------------------------------------------------------------ shops list
async function shopsView(c) {
  const counts = {};
  for (const s of S.shops) counts[s.state] = (counts[s.state] ?? 0) + 1;
  const table = h('div', { class: 'card tablewrap' });
  const draw = () => {
    const needle = S.search.trim().toLowerCase();
    const rows = S.shops.filter((s) => (!S.state || s.state === S.state)
      && (!needle || [s.name, s.slug, s.owner_email, s.city, s.phone].some((v) => String(v ?? '').toLowerCase().includes(needle))));
    clear(table).append(rows.length
      ? h('table', {}, h('thead', {}, h('tr', {}, ['Shop', 'Status', 'Plan', 'Orders', 'Printers', 'Joined', ''].map((x) => h('th', {}, x)))),
          h('tbody', {}, rows.map((s) => h('tr', { class: 'click', onclick: () => openShop(s.id) },
            h('td', {}, h('strong', {}, s.name), h('div', { class: 'muted small' }, s.owner_email ?? ''), h('div', { class: 'muted small' }, [s.city, s.phone].filter(Boolean).join(' · '))),
            h('td', {}, chip(s.state), h('div', { class: 'muted small' }, daysText(s))),
            h('td', {}, s.plan_name ?? '—'),
            h('td', { class: 'num' }, s.orders, s.last_order_at ? h('div', { class: 'muted small' }, `last ${dateOnly(s.last_order_at)}`) : null),
            h('td', { class: 'num' }, `${s.printers}`, h('div', { class: 'muted small' }, s.agents_online ? 'computer online' : 'offline')),
            h('td', { class: 'num' }, dateOnly(s.created_at)),
            h('td', {}, h('button', { class: 'btn small' }, 'Open'))))))
      : h('p', { class: 'muted' }, S.shops.length ? 'No shops match.' : 'No shops yet. They appear here when someone signs up.'));
  };
  const search = h('input', { type: 'text', placeholder: 'Search name, link, email, phone…', value: S.search, 'aria-label': 'Search shops', oninput: (e) => { S.search = e.target.value; draw(); } });
  const state = h('select', { 'aria-label': 'Filter by status', onchange: (e) => { S.state = e.target.value; draw(); } },
    h('option', { value: '' }, `All shops (${S.shops.length})`),
    ...Object.entries(STATE).filter(([k]) => counts[k]).map(([k, [label]]) => h('option', { value: k, selected: S.state === k }, `${label} (${counts[k]})`)));
  clear(c).append(h('div', { class: 'toolbar' }, search, state), table);
  draw();
}

// ------------------------------------------------------------------ one shop
async function shopView(c) {
  let d;
  try { d = await call(`/shops/${S.shopId}`); } catch (e) { S.shopId = null; throw e; }
  const s = d.shop;
  const done = (msg) => async (fn) => { if (await act(fn, msg)) { S.shops = await call('/shops'); await show(); } };
  const extend = (days, markPaid, msg) => done(msg)(() => call(`/shops/${s.id}/extend`, { method: 'POST', json: { days, markPaid } }));

  const plan = h('select', {}, S.plans.map((p) => h('option', { value: p.id, selected: p.id === s.plan_id }, `${p.name}${p.is_active ? '' : ' (off)'}`)));
  const sub = h('select', {}, [['trialing', 'Free trial'], ['active', 'Paid'], ['past_due', 'Payment late'], ['cancelled', 'Cancelled']].map(([v, l]) => h('option', { value: v, selected: s.sub_status === v }, l)));
  const end = h('input', { type: 'date', value: s.current_period_end ? new Date(s.current_period_end).toISOString().slice(0, 10) : '' });
  const note = h('textarea', { rows: 3, maxlength: 2000, placeholder: 'Private notes about this shop (only you see this)' });
  note.value = s.admin_note ?? '';
  const secret = h('div', { class: 'hidden' });
  const confirm = h('input', { type: 'text', placeholder: s.slug, autocomplete: 'off', 'aria-label': 'Type the shop link to confirm' });
  const del = h('button', { class: 'btn danger', disabled: true, onclick: () => act(() => call(`/shops/${s.id}`, { method: 'DELETE', json: { confirmSlug: confirm.value } }), 'Shop deleted').then(async (ok) => { if (ok) { S.shopId = null; await reload(); } }) }, 'Delete this shop for good');
  confirm.addEventListener('input', () => { del.disabled = confirm.value !== s.slug; });

  clear(c).append(
    h('div', { class: 'row between', style: 'margin-bottom:12px' },
      h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => { S.shopId = null; show(); } }, '← All shops'), h('h1', { style: 'margin:0' }, s.name), chip(s.state), h('span', { class: 'muted' }, daysText(s))),
      h('a', { class: 'btn small', href: `/s/${s.slug}`, target: '_blank', rel: 'noopener' }, 'Open customer page')),

    h('section', { class: 'card stack' }, h('h2', {}, 'Free trial and subscription'),
      h('p', { class: 'muted', style: 'margin:0' }, `${s.plan_name ?? 'No plan'} · ${STATE[s.state]?.[0] ?? s.state} · ${s.state === 'expired' ? 'ended' : 'ends'} ${dateOnly(s.current_period_end)}`),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => extend(7, false, 'Added 7 days') }, '+7 days'),
        h('button', { class: 'btn', onclick: () => extend(14, false, 'Added 14 days') }, '+14 days'),
        h('button', { class: 'btn', onclick: () => extend(30, false, 'Added 30 days') }, '+30 days'),
        h('button', { class: 'btn primary', onclick: () => extend(30, true, 'Marked as paid for 30 days') }, 'Mark paid +30 days'),
        h('button', { class: 'btn primary', onclick: () => extend(365, true, 'Marked as paid for 1 year') }, 'Mark paid +1 year')),
      h('p', { class: 'small muted', style: 'margin:0' }, 'Days are added to the current end date, or counted from today if it already ended. "Mark paid" also sets the status to Paid.'),
      h('details', {}, h('summary', { class: 'small muted' }, 'Set plan, status and end date yourself'),
        h('div', { class: 'grid3', style: 'margin-top:10px' }, field('Plan', plan), field('Status', sub), field('Ends on', end)),
        h('div', { style: 'margin-top:10px' }, h('button', { class: 'btn', onclick: () => done('Saved')(() => call(`/shops/${s.id}/subscription`, { method: 'PUT', json: { planId: plan.value, status: sub.value, periodEnd: new Date(end.value + 'T23:59:59Z').toISOString() } })) }, 'Save')))),

    h('section', { class: 'card stack' }, h('h2', {}, 'Account'),
      h('div', { class: 'row' },
        s.status === 'pending' && h('button', { class: 'btn primary', onclick: () => done('Shop approved')(() => call(`/shops/${s.id}`, { method: 'PATCH', json: { status: 'active' } })) }, 'Approve shop'),
        s.status === 'active' && h('button', { class: 'btn danger', onclick: () => done('Shop suspended')(() => call(`/shops/${s.id}`, { method: 'PATCH', json: { status: 'suspended' } })) }, 'Suspend shop'),
        s.status === 'suspended' && h('button', { class: 'btn primary', onclick: () => done('Shop reactivated')(() => call(`/shops/${s.id}`, { method: 'PATCH', json: { status: 'active' } })) }, 'Reactivate shop'),
        h('button', { class: 'btn', onclick: async () => {
          if (!window.confirm(`Create a new password for the owner of ${s.name}? The old password stops working.`)) return;
          try {
            const r = await call(`/shops/${s.id}/reset-password`, { method: 'POST' });
            clear(secret).append(h('div', { class: 'notice ok' }, h('div', {}, `New password for ${r.email}. Send it to the owner now; it is shown only once.`), h('div', { class: 'secret' }, r.password)));
            secret.classList.remove('hidden');
          } catch (e) { toast(e.message, true); }
        } }, 'Reset owner password')),
      secret,
      s.status === 'suspended' && h('div', { class: 'notice bad' }, 'Suspended: the owner cannot sign in and customers cannot order.'),
      h('dl', { class: 'kv' }, h('dt', {}, 'Owner'), h('dd', {}, d.users.filter((u) => u.role === 'owner').map((u) => u.email).join(', ') || '—'),
        h('dt', {}, 'Phone'), h('dd', {}, s.phone ?? '—'), h('dt', {}, 'City'), h('dd', {}, s.city ?? '—'),
        h('dt', {}, 'Shop link'), h('dd', {}, `/s/${s.slug}`), h('dt', {}, 'Joined'), h('dd', {}, dateOnly(s.created_at)),
        h('dt', {}, 'Staff accounts'), h('dd', {}, d.users.filter((u) => u.role === 'staff').length)),
      field('Private note', note),
      h('div', {}, h('button', { class: 'btn', onclick: () => act(() => call(`/shops/${s.id}`, { method: 'PATCH', json: { adminNote: note.value } }), 'Note saved') }, 'Save note'))),

    h('section', { class: 'card stack' }, h('h2', {}, 'Usage'),
      h('div', { class: 'stats', style: 'margin:0' },
        h('div', { class: 'stat' }, h('b', {}, s.orders), h('span', { class: 'muted small' }, 'Orders')),
        h('div', { class: 'stat' }, h('b', {}, money(s.revenue)), h('span', { class: 'muted small' }, 'Paid by customers')),
        h('div', { class: 'stat' }, h('b', {}, dateOnly(s.last_order_at)), h('span', { class: 'muted small' }, 'Last order'))),
      h('div', { class: 'lines' },
        ...d.agents.map((a) => h('div', {}, h('span', {}, h('span', { class: `dot ${a.online ? 'on' : ''}`, 'aria-hidden': 'true' }), ` Computer: ${a.name}`), h('span', { class: 'muted small' }, a.online ? 'online' : a.paired ? `last seen ${fmtTime(a.last_seen_at)}` : 'not paired'))),
        ...d.printers.map((p) => h('div', {}, h('span', {}, `Printer: ${p.display_name}`), h('span', { class: 'muted small' }, `${p.supports_color ? 'colour' : 'B&W'}, ${p.supports_duplex ? '2-sided' : '1-sided'}${p.is_active ? '' : ' · off'}`))),
        !d.agents.length && !d.printers.length ? h('div', {}, h('span', { class: 'muted' }, 'No computer or printer set up yet.')) : null)),

    d.orders.length ? h('section', { class: 'card tablewrap' }, h('h2', {}, 'Recent orders'),
      h('table', {}, h('thead', {}, h('tr', {}, ['Code', 'When', 'Amount', 'Payment', 'Status'].map((x) => h('th', {}, x)))),
        h('tbody', {}, d.orders.map((o) => h('tr', {}, h('td', { class: 'num' }, o.public_code), h('td', {}, fmtTime(o.created_at)), h('td', { class: 'num' }, money(o.amount)), h('td', {}, `${o.payment_method ?? '—'} · ${o.payment_status}`), h('td', {}, o.status)))))) : null,

    d.activity.length ? h('section', { class: 'card' }, h('h2', {}, 'Admin activity on this shop'),
      h('div', { class: 'lines' }, d.activity.map((a) => h('div', {}, h('span', {}, `${LABEL[a.action] ?? a.action} ${detail(a)}`), h('span', { class: 'muted small' }, `${a.admin_email ?? ''} · ${fmtTime(a.created_at)}`))))) : null,

    h('section', { class: 'card stack danger-zone' }, h('h2', {}, 'Delete shop'),
      h('p', { class: 'muted', style: 'margin:0' }, `This removes ${s.name} with all its orders, printers and files. It cannot be undone. Suspend the shop instead if you only want to stop it.`),
      h('div', { class: 'row' }, confirm, del)));
}

// ------------------------------------------------------------------ plans
async function plansView(c) {
  const plans = await call('/plans');
  S.plans = plans;
  let editing = null;
  const box = h('div');
  const input = (v, type = 'text', w = '') => h('input', { type, value: v ?? '', style: w });
  const draw = () => {
    clear(box).append(h('section', { class: 'card tablewrap' }, h('h2', {}, 'Plans'),
      h('table', {}, h('thead', {}, h('tr', {}, ['Plan', 'Rs / month', 'Printers', 'Orders / month', 'Shops', 'On', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, plans.map((p) => {
          if (editing === p.id) {
            const f = { name: input(p.name), price: input(p.price_monthly, 'number', 'max-width:110px'), printers: input(p.max_printers, 'number', 'max-width:90px'), orders: input(p.max_orders_per_month, 'number', 'max-width:130px') };
            f.orders.placeholder = 'unlimited';
            return h('tr', {}, h('td', {}, f.name), h('td', {}, f.price), h('td', {}, f.printers), h('td', {}, f.orders), h('td', { class: 'num' }, p.shops), h('td', {}, ''),
              h('td', {}, h('div', { class: 'row', style: 'gap:6px' },
                h('button', { class: 'btn small primary', onclick: async () => { if (await act(() => call(`/plans/${p.id}`, { method: 'PUT', json: { name: f.name.value, priceMonthly: f.price.value, maxPrinters: f.printers.value, maxOrdersPerMonth: f.orders.value } }), 'Plan saved')) { editing = null; reload(); } } }, 'Save'),
                h('button', { class: 'btn small', onclick: () => { editing = null; draw(); } }, 'Cancel'))));
          }
          return h('tr', {}, h('td', {}, h('strong', {}, p.name)), h('td', { class: 'num' }, p.price_monthly), h('td', { class: 'num' }, p.max_printers), h('td', { class: 'num' }, p.max_orders_per_month ?? 'Unlimited'), h('td', { class: 'num' }, p.shops),
            h('td', {}, h('input', { type: 'checkbox', checked: p.is_active, 'aria-label': `${p.name} is on`, onchange: async (e) => { if (await act(() => call(`/plans/${p.id}`, { method: 'PUT', json: { isActive: e.target.checked } }), 'Saved')) reload(); } })),
            h('td', {}, h('button', { class: 'btn small', onclick: () => { editing = p.id; draw(); } }, 'Edit')));
        })))));
  };
  const np = { name: h('input', { type: 'text', placeholder: 'Plan name' }), price: h('input', { type: 'number', placeholder: 'Rs / month' }), printers: h('input', { type: 'number', placeholder: 'Max printers', value: 1 }), orders: h('input', { type: 'number', placeholder: 'Orders / month (blank = unlimited)' }) };
  clear(c).append(box, h('section', { class: 'card stack' }, h('h2', {}, 'Add a plan'),
    h('div', { class: 'grid2' }, np.name, np.price, np.printers, np.orders),
    h('div', {}, h('button', { class: 'btn primary', onclick: async () => { if (await act(() => call('/plans', { method: 'POST', json: { name: np.name.value, priceMonthly: np.price.value, maxPrinters: np.printers.value, maxOrdersPerMonth: np.orders.value } }), 'Plan added')) reload(); } }, 'Add plan'))));
  draw();
}

// ------------------------------------------------------------------ settings
async function settingsView(c) {
  const st = await call('/settings');
  const days = h('input', { type: 'number', min: 1, max: 365, value: st.defaultTrialDays });
  const approve = h('input', { type: 'checkbox', checked: st.requireApproval });
  const signups = h('input', { type: 'checkbox', checked: st.signupsEnabled });
  const plan = h('select', {}, h('option', { value: '' }, 'Cheapest active plan'), ...S.plans.filter((p) => p.is_active).map((p) => h('option', { value: p.id, selected: p.id === st.defaultPlanId }, p.name)));
  const contact = h('input', { type: 'text', maxlength: 300, value: st.contactInfo, placeholder: 'e.g. WhatsApp 0300 1234567' });
  clear(c).append(h('section', { class: 'card stack' }, h('h2', {}, 'New shops'),
    field('Free trial length (days)', days, 'Applies to shops that sign up from now on. Existing shops keep their end date.'),
    field('Plan for new shops', plan),
    h('label', { class: 'check' }, signups, 'Allow new shops to sign up'),
    h('label', { class: 'check' }, approve, 'New shops must be approved by me before they can take orders'),
    field('Your contact details shown to shops', contact, 'Shown in their dashboard when their trial is ending or has ended, so they know how to pay you.'),
    h('div', {}, h('button', { class: 'btn primary', onclick: async () => {
      const r = await act(() => call('/settings', { method: 'PUT', json: { defaultTrialDays: Number(days.value), defaultPlanId: plan.value || null, signupsEnabled: signups.checked, requireApproval: approve.checked, contactInfo: contact.value } }), 'Settings saved');
      if (r) show();
    } }, 'Save settings'))));
}

// ------------------------------------------------------------------ activity
const LABEL = {
  'shop.status': 'Changed shop status', 'shop.note': 'Edited note', 'subscription.set': 'Changed subscription', 'subscription.extend': 'Extended',
  'subscription.paid': 'Marked as paid', 'owner.password_reset': 'Reset owner password', 'shop.delete': 'Deleted shop',
  'plan.add': 'Added plan', 'plan.edit': 'Edited plan', 'settings.change': 'Changed settings',
};
function detail(a) {
  const d = a.details ?? {};
  if (a.action === 'shop.status') return `${d.from} → ${d.to}`;
  if (a.action === 'subscription.extend' || a.action === 'subscription.paid') return `+${plural(d.days, 'day')}, until ${dateOnly(d.until)}`;
  if (a.action === 'subscription.set') return `${d.status}, until ${dateOnly(d.periodEnd)}`;
  if (a.action === 'plan.add' || a.action === 'plan.edit') return d.name ?? '';
  if (a.action === 'settings.change') return Object.keys(d).join(', ');
  return '';
}

async function activityView(c) {
  const rows = await call('/audit?limit=200');
  clear(c).append(h('section', { class: 'card tablewrap' }, h('h2', {}, 'Activity'),
    rows.length ? h('table', {}, h('thead', {}, h('tr', {}, ['When', 'Who', 'What', 'Shop'].map((x) => h('th', {}, x)))),
      h('tbody', {}, rows.map((a) => h('tr', {}, h('td', {}, fmtTime(a.created_at)), h('td', {}, a.admin_email ?? ''), h('td', {}, `${LABEL[a.action] ?? a.action} ${detail(a)}`), h('td', {}, a.shop_name ?? '—')))))
      : h('p', { class: 'muted' }, 'Nothing yet. Every change you make here is recorded.')));
}

main();
