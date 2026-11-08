import { h, api, clear, $, store, toast, money, fmtTime } from './common.js';

const token = store.get('shopToken');
if (!token) location.href = '/login';

const call = (path, opts = {}) =>
  api('/api/shop' + path, { ...opts, token }).catch((e) => {
    if (e.status === 401) { store.del('shopToken'); location.href = '/login'; }
    throw e;
  });
const act = async (fn, okMsg) => {
  try { await fn(); if (okMsg) toast(okMsg); return true; }
  catch (e) { toast(e.message, true); return false; }
};

const app = $('#app');
const S = { me: null, tab: 'orders', timer: null };
const TABS = [['orders', 'Orders'], ['printers', 'Printers'], ['prices', 'Prices'], ['payments', 'Payments'], ['shop', 'Shop & QR']];
const SIZES = ['A4', 'A3', 'A5', 'Legal', 'Letter'];
const field = (label, input, hint) => h('div', { class: 'field' }, h('label', {}, label), input, hint && h('div', { class: 'small muted' }, hint));
const isOwner = () => S.me.role === 'owner';

function shell() {
  const { shop } = S.me;
  clear(app).append(
    h('header', { class: 'top' },
      h('div', { class: 'in' },
        h('div', {}, h('strong', {}, shop.name), ' ',
          h('span', { class: `chip ${shop.status === 'active' ? 'ok' : 'warn'}` }, shop.status === 'active' ? 'Open' : shop.status),
          ' ', h('span', { class: 'chip info' }, `${shop.plan_name ?? 'No plan'}${shop.sub_status === 'trialing' ? ' trial' : ''}`)),
        h('button', { class: 'btn small', onclick: () => { store.del('shopToken'); location.href = '/login'; } }, 'Sign out')),
      h('nav', { class: 'tabs', role: 'tablist' }, TABS.map(([k, label]) =>
        h('button', { role: 'tab', 'aria-selected': S.tab === k ? 'true' : 'false', onclick: () => { S.tab = k; show(); } }, label)))),
    h('main', { class: 'wrap wide', id: 'content' }));
}

async function show() {
  clearInterval(S.timer);
  shell();
  const c = $('#content');
  const views = { orders: ordersView, printers: printersView, prices: pricesView, payments: paymentsView, shop: shopView };
  try { await views[S.tab](c); } catch (e) { clear(c).append(h('div', { class: 'notice bad' }, e.message)); }
}

// ------------------------------------------------------------------ Orders
const STATUS = {
  awaiting_payment: ['Awaiting payment', 'warn'], paid: ['Queued', 'info'], printing: ['Printing', 'info'], completed: ['Done', 'ok'],
  failed: ['Problem', 'bad'], cancelled: ['Cancelled', 'bad'], expired: ['Expired', ''],
};
const PROBLEM = { paid_but_cannot_print: 'Paid, but the file or printer was missing', paid_amount_mismatch: 'Paid a different amount than the final price' };

async function ordersView(c) {
  let filter = '';
  const statsBox = h('div', { class: 'stats' });
  const list = h('div', { class: 'card tablewrap' });
  const sel = h('select', { style: 'max-width:200px', onchange: (e) => { filter = e.target.value; refresh(); } },
    h('option', { value: '' }, 'All orders'), ...Object.entries(STATUS).map(([k, [l]]) => h('option', { value: k }, l)));
  clear(c).append(statsBox, h('div', { class: 'row between', style: 'margin-bottom:10px' }, h('h2', { style: 'margin:0' }, 'Orders'), sel), list);

  async function refresh() {
    const [st, orders] = await Promise.all([call('/stats'), call('/orders' + (filter ? `?status=${filter}` : ''))]);
    const stat = (n, label) => h('div', { class: 'stat' }, h('b', {}, n), h('span', { class: 'muted small' }, label));
    clear(statsBox).append(stat(st.orders_today, 'Orders today'), stat(money(st.revenue_today), 'Paid today'), stat(st.awaiting_cash, 'Waiting for cash'), stat(st.in_progress, 'In the print queue'), stat(st.failed_recent, 'Problems (7 days)'));

    const btn = (label, fn, cls = '') => h('button', { class: `btn small ${cls}`, onclick: async () => { if (await act(fn)) refresh(); } }, label);
    const rows = orders.map((o) => {
      const [label, cls] = STATUS[o.status] ?? [o.status, ''];
      const actions = [];
      if (o.status === 'awaiting_payment' && o.payment_method === 'cash') actions.push(btn('Cash received', () => call(`/orders/${o.id}/mark-paid`, { method: 'POST' })));
      if (o.status === 'awaiting_payment') actions.push(btn('Cancel', () => call(`/orders/${o.id}/cancel`, { method: 'POST' }), 'danger'));
      if (['failed', 'completed'].includes(o.status) && o.payment_status === 'paid' && !o.failure_reason?.startsWith('paid_') && !o.file_deleted_at) actions.push(btn('Print again', () => call(`/orders/${o.id}/reprint`, { method: 'POST' })));
      if (o.status === 'failed' && o.payment_status === 'paid') actions.push(btn('Mark refunded', () => call(`/orders/${o.id}/refund`, { method: 'POST' }), 'danger'));
      return h('tr', {},
        h('td', { class: 'num' }, h('strong', {}, o.public_code), h('div', { class: 'muted small' }, fmtTime(o.created_at))),
        h('td', {}, o.file_name ?? '—', h('div', { class: 'muted small' }, o.customer_phone ?? '')),
        h('td', {}, `${o.color_mode === 'color' ? 'Colour' : 'B&W'}, ${o.sides === 'double' ? '2-sided' : '1-sided'}, ${o.paper_size}`,
          h('div', { class: 'muted small' }, `${o.page_from ? `pp ${o.page_from}-${o.page_to}` : `${o.total_pages ?? '?'} pages`} × ${o.copies}${o.printer_name ? ` · ${o.printer_name}` : ''}`)),
        h('td', { class: 'num' }, money(o.amount), h('div', { class: 'muted small' }, o.payment_method ?? '')),
        h('td', {}, h('span', { class: `chip ${cls}` }, label), o.failure_reason && h('div', { class: 'small muted' }, PROBLEM[o.failure_reason] ?? o.failure_reason.replace('print_failed: ', 'Printer: '))),
        h('td', {}, h('div', { class: 'row', style: 'gap:6px' }, ...actions)));
    });
    clear(list).append(orders.length
      ? h('table', {}, h('thead', {}, h('tr', {}, ['Code', 'File', 'Print', 'Amount', 'Status', ''].map((x) => h('th', {}, x)))), h('tbody', {}, rows))
      : h('p', { class: 'muted' }, 'No orders yet. Print your shop QR from the "Shop & QR" tab and put it on the counter.'));
  }
  await refresh();
  S.timer = setInterval(() => document.visibilityState === 'visible' && refresh().catch(() => {}), 5000);
}

// ------------------------------------------------------------------ Printers
async function printersView(c) {
  const [agents, printers] = await Promise.all([call('/agents'), call('/printers')]);
  const reload = () => show();
  const owner = isOwner();

  const nameIn = h('input', { type: 'text', placeholder: 'Counter PC', maxlength: 80 });
  const agentCard = h('section', { class: 'card stack' },
    h('h2', {}, 'Computers'),
    h('p', { class: 'muted small' }, 'Install the PrintSaaS Agent on the computer that is connected to your printers. It sits in the taskbar, shows whether you are connected, and starts with the computer. Add the computer here, then type the code into the app.'),
    S.me.agentDownloadUrl && h('div', {}, h('a', { class: 'btn', href: S.me.agentDownloadUrl, target: '_blank', rel: 'noopener' }, 'Download PrintSaaS Agent')),
    ...agents.map((a) => h('div', { class: 'card' },
      h('div', { class: 'row between' },
        h('div', {}, h('span', { class: `dot ${a.online ? 'on' : ''}`, 'aria-hidden': 'true' }), ' ', h('strong', {}, a.name), ' ',
          h('span', { class: 'muted small' }, a.online ? 'Online' : a.paired ? `Offline${a.last_seen_at ? ` · last seen ${fmtTime(a.last_seen_at)}` : ''}` : 'Not paired yet')),
        owner && h('div', { class: 'row', style: 'gap:6px' },
          h('button', { class: 'btn small', onclick: async () => (await act(() => call(`/agents/${a.id}/pairing`, { method: 'POST' }))) && reload() }, a.paired ? 'Re-pair' : 'New code'),
          h('button', { class: 'btn small danger', onclick: async () => confirm(`Remove ${a.name}?`) && (await act(() => call(`/agents/${a.id}`, { method: 'DELETE' }))) && reload() }, 'Remove'))),
      a.pairing_code && h('div', { class: 'stack', style: 'margin-top:10px' },
        h('div', { class: 'small muted' }, 'Open PrintSaaS Agent on the shop computer and type this code (works for 15 minutes):'),
        h('div', { class: 'pair' }, a.pairing_code),
        h('details', {}, h('summary', { class: 'small muted' }, 'Command line instead'),
          h('div', { class: 'code-block' }, `node agent.js pair ${a.pairing_code} --server ${location.origin}\nnode agent.js`))))),
    owner && h('div', { class: 'row' }, h('div', { class: 'grow' }, nameIn),
      h('button', { class: 'btn primary', onclick: async () => (await act(() => call('/agents', { method: 'POST', json: { name: nameIn.value } }))) && reload() }, 'Add computer')));

  // printer form (create / edit)
  let editing = null;
  const formBox = h('div');
  const showForm = (p) => {
    editing = p;
    const paired = agents.filter((a) => a.paired);
    const agentSel = h('select', { disabled: !!p }, paired.map((a) => h('option', { value: a.id }, a.name)));
    const sysSel = h('select', { disabled: !!p });
    const sysManual = h('input', { type: 'text', placeholder: 'Or type the exact printer name', disabled: !!p, value: p?.system_name ?? '' });
    const fillSys = () => {
      clear(sysSel);
      const a = paired.find((x) => x.id === agentSel.value);
      for (const d of a?.detected_printers ?? []) sysSel.append(h('option', { value: d.name }, d.name));
      if (!sysSel.children.length) sysSel.append(h('option', { value: '' }, 'No printers reported yet'));
    };
    agentSel.addEventListener('change', fillSys); fillSys();
    const dn = h('input', { type: 'text', maxlength: 80, value: p?.display_name ?? '', placeholder: 'e.g. Laser B&W' });
    const col = h('input', { type: 'checkbox', checked: !!p?.supports_color });
    const dup = h('input', { type: 'checkbox', checked: !!p?.supports_duplex });
    const sizes = SIZES.map((z) => [z, h('input', { type: 'checkbox', checked: (p?.paper_sizes ?? ['A4']).includes(z) })]);
    clear(formBox).append(h('section', { class: 'card stack' },
      h('h2', {}, p ? `Edit ${p.display_name}` : 'Add a printer'),
      !p && !paired.length && h('div', { class: 'notice' }, 'Pair a computer first (above).'),
      !p && h('div', { class: 'grid2' }, field('Computer', agentSel), field('Printer on that computer', sysSel)),
      !p && field('', sysManual),
      field('Name shown to you', dn),
      h('div', { class: 'row' }, h('label', { class: 'check' }, col, 'Prints colour'), h('label', { class: 'check' }, dup, 'Prints on both sides')),
      h('div', {}, h('label', {}, 'Paper sizes loaded'), h('div', { class: 'row' }, sizes.map(([z, i]) => h('label', { class: 'check' }, i, z)))),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: async () => {
          const body = { displayName: dn.value, supportsColor: col.checked, supportsDuplex: dup.checked, paperSizes: sizes.filter(([, i]) => i.checked).map(([z]) => z) };
          const ok = await act(() => p
            ? call(`/printers/${p.id}`, { method: 'PATCH', json: body })
            : call('/printers', { method: 'POST', json: { ...body, agentId: agentSel.value, systemName: sysManual.value.trim() || sysSel.value } }), 'Saved');
          if (ok) reload();
        } }, 'Save'),
        h('button', { class: 'btn', onclick: () => clear(formBox) }, 'Cancel'))));
    formBox.scrollIntoView({ behavior: 'smooth' });
  };

  const stChip = (p) => {
    if (!p.agent_online) return h('span', { class: 'chip' }, 'Offline');
    if (p.status === 'error') return h('span', { class: 'chip bad' }, 'Error');
    return h('span', { class: 'chip ok' }, 'Ready');
  };
  const printerCard = h('section', { class: 'card tablewrap' },
    h('div', { class: 'row between' }, h('h2', {}, 'Printers'), owner && h('button', { class: 'btn primary small', onclick: () => showForm(null) }, 'Add printer')),
    printers.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Printer', 'Can do', 'Status', 'Use', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, printers.map((p) => h('tr', {},
        h('td', {}, h('strong', {}, p.display_name), h('div', { class: 'muted small' }, `${p.system_name} · ${p.agent_name}`)),
        h('td', {}, [p.supports_color ? 'Colour' : 'B&W only', p.supports_duplex ? '2-sided' : '1-sided', p.paper_sizes.join('/')].join(' · ')),
        h('td', {}, stChip(p), p.status === 'error' && owner && h('div', {}, h('button', { class: 'btn small', onclick: async () => (await act(() => call(`/printers/${p.id}`, { method: 'PATCH', json: { displayName: p.display_name, supportsColor: p.supports_color, supportsDuplex: p.supports_duplex, paperSizes: p.paper_sizes, clearError: true } }))) && reload() }, 'Clear error'))),
        h('td', {}, h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: p.is_active, disabled: !owner, onchange: async (e) => (await act(() => call(`/printers/${p.id}`, { method: 'PATCH', json: { displayName: p.display_name, supportsColor: p.supports_color, supportsDuplex: p.supports_duplex, paperSizes: p.paper_sizes, isActive: e.target.checked } }))) }), 'On')),
        h('td', {}, owner && h('div', { class: 'row', style: 'gap:6px' },
          h('button', { class: 'btn small', onclick: () => showForm(p) }, 'Edit'),
          h('button', { class: 'btn small danger', onclick: async () => confirm(`Remove ${p.display_name}?`) && (await act(() => call(`/printers/${p.id}`, { method: 'DELETE' }))) && reload() }, 'Remove')))))))
      : h('p', { class: 'muted' }, 'No printers yet.'));
  clear(c).append(agentCard, formBox, printerCard);
}

// ------------------------------------------------------------------ Prices
async function pricesView(c) {
  const rules = (await call('/pricing')).map((r) => ({ colorMode: r.color_mode, paperSize: r.paper_size, sides: r.sides, pricePerPage: r.price_per_page }));
  const owner = isOwner();
  const body = h('tbody');
  const draw = () => {
    clear(body);
    rules.forEach((r, i) => body.append(h('tr', {},
      h('td', {}, h('select', { disabled: !owner, onchange: (e) => (r.colorMode = e.target.value) }, h('option', { value: 'bw', selected: r.colorMode === 'bw' }, 'Black & white'), h('option', { value: 'color', selected: r.colorMode === 'color' }, 'Colour'))),
      h('td', {}, h('select', { disabled: !owner, onchange: (e) => (r.paperSize = e.target.value) }, SIZES.map((z) => h('option', { value: z, selected: z === r.paperSize }, z)))),
      h('td', {}, h('select', { disabled: !owner, onchange: (e) => (r.sides = e.target.value) }, h('option', { value: 'single', selected: r.sides === 'single' }, 'One side'), h('option', { value: 'double', selected: r.sides === 'double' }, 'Both sides'))),
      h('td', {}, h('input', { type: 'number', min: 0, step: '0.5', value: r.pricePerPage, disabled: !owner, style: 'max-width:110px', onchange: (e) => (r.pricePerPage = e.target.value) })),
      h('td', {}, owner && h('button', { class: 'btn small danger', onclick: () => { rules.splice(i, 1); draw(); } }, 'Remove')))));
  };
  draw();
  clear(c).append(h('section', { class: 'card stack' },
    h('h2', {}, 'Price per page'),
    h('p', { class: 'muted small' }, 'Price is per page, multiplied by the number of copies. A customer can only pick combinations that appear here.'),
    h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Colour', 'Paper', 'Sides', 'Rs per page', ''].map((x) => h('th', {}, x)))), body)),
    owner && h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => { rules.push({ colorMode: 'bw', paperSize: 'A4', sides: 'single', pricePerPage: 10 }); draw(); } }, 'Add row'),
      h('button', { class: 'btn primary', onclick: () => act(() => call('/pricing', { method: 'PUT', json: { rules } }), 'Prices saved') }, 'Save prices'))));
}

// ------------------------------------------------------------------ Payments
const GATEWAYS = {
  jazzcash: { title: 'JazzCash', fields: [['merchantId', 'Merchant ID'], ['password', 'Password'], ['integritySalt', 'Integrity salt']] },
  easypaisa: { title: 'Easypaisa', fields: [['storeId', 'Store ID'], ['hashKey', 'Hash key (16 characters)'], ['accountNum', 'Account number'], ['username', 'Inquiry username'], ['password', 'Inquiry password']] },
};

async function paymentsView(c) {
  const accounts = await call('/payment-accounts');
  const owner = isOwner();
  const reload = () => show();
  const cards = accounts.map((a) => {
    if (a.provider === 'cash') {
      return h('section', { class: 'card row between' },
        h('div', {}, h('h2', {}, 'Pay at the counter'), h('p', { class: 'muted small', style: 'margin:0' }, 'Customer gets a code, pays you in cash, and you press "Cash received" to start printing.')),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: a.isActive, disabled: !owner, onchange: (e) => act(() => call('/payment-accounts/cash', { method: 'PUT', json: { isActive: e.target.checked } }), 'Saved') }), 'Accept'));
    }
    const g = GATEWAYS[a.provider];
    const inputs = Object.fromEntries(g.fields.map(([k]) => [k, h('input', { type: k.toLowerCase().includes('password') || k.toLowerCase().includes('salt') || k === 'hashKey' ? 'password' : 'text', autocomplete: 'off', placeholder: a.configured ? '•••• saved (type to replace)' : '' })]));
    const sandbox = h('input', { type: 'checkbox', checked: true });
    const active = h('input', { type: 'checkbox', checked: a.isActive || !a.configured });
    return h('section', { class: 'card stack' },
      h('div', { class: 'row between' }, h('h2', {}, g.title), a.configured ? h('span', { class: `chip ${a.isActive ? 'ok' : ''}` }, a.isActive ? `Live ${a.hint ?? ''}` : 'Saved, turned off') : h('span', { class: 'chip' }, 'Not set up')),
      a.provider === 'easypaisa' && h('div', { class: 'notice' }, 'Test Easypaisa in their sandbox with one small real order before telling customers about it.'),
      h('p', { class: 'muted small' }, `Money goes straight to your ${g.title} merchant account. Keys are stored encrypted and are never shown again.`),
      ...g.fields.map(([k, label]) => field(label, inputs[k])),
      h('div', { class: 'row' }, h('label', { class: 'check' }, sandbox, 'Sandbox (testing) mode'), h('label', { class: 'check' }, active, 'Accept this payment method')),
      owner && h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: async () => {
          const creds = Object.fromEntries(g.fields.map(([k]) => [k, inputs[k].value]));
          const typed = Object.values(creds).some((v) => v);
          const ok = await act(() => call(`/payment-accounts/${a.provider}`, { method: 'PUT', json: { isActive: active.checked, ...(typed || !a.configured ? { credentials: { ...creds, sandbox: sandbox.checked } } : {}) } }), 'Saved');
          if (ok) reload();
        } }, 'Save'),
        a.configured && h('button', { class: 'btn danger', onclick: async () => confirm(`Remove ${g.title} keys?`) && (await act(() => call(`/payment-accounts/${a.provider}`, { method: 'DELETE' }))) && reload() }, 'Remove keys')));
  });
  clear(c).append(h('h2', {}, 'How customers can pay'), ...cards);
}

// ------------------------------------------------------------------ Shop & QR
async function shopView(c) {
  const { shop, shopUrl, qrUrl } = S.me;
  const owner = isOwner();
  const f = { name: h('input', { type: 'text', value: shop.name }), phone: h('input', { type: 'tel', value: shop.phone ?? '' }), city: h('input', { type: 'text', value: shop.city ?? '' }), address: h('input', { type: 'text', value: shop.address ?? '' }) };
  const users = owner ? await call('/users') : [];
  const email = h('input', { type: 'email', placeholder: 'staff@example.com' });
  const pw = h('input', { type: 'password', placeholder: 'Password (8+ characters)', autocomplete: 'new-password' });
  clear(c).append(
    h('section', { class: 'card stack' },
      h('h2', {}, 'Your QR code'),
      h('p', { class: 'muted' }, 'Print this and put it on your counter. Customers scan it and send their files straight to your printers.'),
      h('div', { class: 'row' }, h('img', { class: 'qr', src: qrUrl, alt: `QR code for ${shopUrl}` }),
        h('div', { class: 'stack' }, h('div', { class: 'code-block' }, shopUrl),
          h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => window.print() }, 'Print poster'), h('a', { class: 'btn', href: shopUrl, target: '_blank', rel: 'noopener' }, 'Open customer page'))))),
    h('section', { class: 'card stack' },
      h('h2', {}, 'Shop details'),
      h('div', { class: 'grid2' }, field('Shop name', f.name), field('Phone', f.phone), field('City', f.city), field('Address', f.address)),
      owner && h('div', {}, h('button', { class: 'btn primary', onclick: async () => (await act(() => call('/me', { method: 'PATCH', json: Object.fromEntries(Object.entries(f).map(([k, i]) => [k, i.value])) }), 'Saved')) && (S.me = await call('/me')) }, 'Save details'))),
    h('section', { class: 'card stack' },
      h('h2', {}, 'Plan'),
      h('p', {}, `${shop.plan_name ?? '—'} · ${shop.sub_status ?? '—'}`, shop.current_period_end && ` · until ${new Date(shop.current_period_end).toLocaleDateString('en-GB')}`),
      h('p', { class: 'muted small' }, `Up to ${shop.max_printers ?? '?'} printer(s)${shop.max_orders_per_month ? `, ${shop.max_orders_per_month} orders a month` : ', unlimited orders'}.`)),
    owner && h('section', { class: 'card stack' },
      h('h2', {}, 'Staff'),
      h('p', { class: 'muted small' }, 'Staff can see orders and press "Cash received". Only owners change prices, printers and payments.'),
      ...users.map((u) => h('div', { class: 'row between' }, h('span', {}, u.email, ' ', h('span', { class: 'chip' }, u.role)),
        u.role === 'staff' && h('button', { class: 'btn small danger', onclick: async () => (await act(() => call(`/users/${u.id}`, { method: 'DELETE' }))) && show() }, 'Remove'))),
      h('div', { class: 'grid2' }, email, pw),
      h('div', {}, h('button', { class: 'btn', onclick: async () => (await act(() => call('/users', { method: 'POST', json: { email: email.value, password: pw.value } }), 'Staff added')) && show() }, 'Add staff'))),
    h('div', { class: 'poster' }, h('h1', {}, shop.name), h('p', {}, 'Scan to upload your file and print'), h('img', { src: qrUrl, alt: '' }), h('p', {}, shopUrl)));
}

try {
  S.me = await call('/me');
  if (S.me.shop.status === 'pending') toast('Your shop is waiting for approval. You can set everything up meanwhile.');
  show();
} catch (e) {
  clear(app).append(h('main', { class: 'wrap' }, h('div', { class: 'notice bad' }, e.message), h('p', {}, h('a', { href: '/login' }, 'Back to sign in'))));
}
