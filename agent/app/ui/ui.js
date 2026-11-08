// Window of the tray app. Talks to the main process only through window.agent (see preload.cjs).
const api = window.agent;
const app = document.getElementById('app');

const T = {
  en: {
    notSetup: 'Not set up yet', connected: 'Connected', connectedTo: 'Connected to {shop}', connecting: 'Connecting…', disconnected: 'Not connected',
    subConnected: 'Ready. Paid orders will print on this computer.', subConnecting: 'Contacting the server…', subDisconnected: 'Trying again automatically. Check the internet connection.',
    subUnpaired: 'Connect this computer to your shop.',
    connectTitle: 'Connect this computer', step1: 'Open your PrintSaaS dashboard and go to Printers → Add computer.', step2: 'Type the code you see there:',
    code: 'Code', connect: 'Connect', connectingBusy: 'Connecting… the first time can take up to a minute.', server: 'Server address', changeServer: 'Change server',
    needCode: 'Enter the code from your dashboard.',
    fetch: 'Fetch my printers', fetching: 'Looking for printers…', printers: 'Printers on this computer', noPrinters: 'No printers found on this computer.',
    colour: 'Colour', bw: 'B&W', twoSided: '2-sided', oneSided: '1-sided', virtual: 'virtual', isDefault: 'default',
    fetched: 'Found {found} printer(s). Added to your shop: {added}. Already there: {existing}.', limit: '{n} not added because your plan allows {max} printer(s).',
    virtualNote: '{n} virtual printer(s) (PDF, Fax…) were skipped.', addVirtual: 'Add virtual printers too', nothingNew: 'Nothing new to add.',
    jobs: 'Recent orders', noJobs: 'No orders yet.', printing: 'Printing', done: 'Done', failed: 'Failed',
    settings: 'Settings', autoStart: 'Start automatically when this computer starts', testMode: 'Test mode (do not really print)', testForced: '(set by PRINT_DRY_RUN)',
    dashboard: 'Open dashboard', disconnect: 'Disconnect this computer', confirmDisconnect: 'Disconnect this computer from your shop? Orders will stop printing here.',
    keepRunning: 'Closing this window keeps the agent running in the taskbar.', lang: 'اردو',
  },
  ur: {
    notSetup: 'ابھی سیٹ اپ نہیں ہوا', connected: 'جڑا ہوا ہے', connectedTo: '{shop} سے جڑا ہوا ہے', connecting: 'جڑ رہا ہے…', disconnected: 'جڑا ہوا نہیں',
    subConnected: 'تیار۔ ادا شدہ آرڈر اس کمپیوٹر پر پرنٹ ہوں گے۔', subConnecting: 'سرور سے رابطہ ہو رہا ہے…', subDisconnected: 'خود بخود دوبارہ کوشش ہو رہی ہے۔ انٹرنیٹ چیک کریں۔',
    subUnpaired: 'اس کمپیوٹر کو اپنی دکان سے جوڑیں۔',
    connectTitle: 'اس کمپیوٹر کو جوڑیں', step1: 'اپنا PrintSaaS ڈیش بورڈ کھولیں اور Printers ← Add computer پر جائیں۔', step2: 'وہاں نظر آنے والا کوڈ یہاں لکھیں:',
    code: 'کوڈ', connect: 'جوڑیں', connectingBusy: 'جڑ رہا ہے… پہلی بار ایک منٹ تک لگ سکتا ہے۔', server: 'سرور کا پتہ', changeServer: 'سرور بدلیں',
    needCode: 'ڈیش بورڈ سے کوڈ لکھیں۔',
    fetch: 'میرے پرنٹرز لائیں', fetching: 'پرنٹرز ڈھونڈ رہا ہے…', printers: 'اس کمپیوٹر کے پرنٹرز', noPrinters: 'اس کمپیوٹر پر کوئی پرنٹر نہیں ملا۔',
    colour: 'رنگین', bw: 'بلیک اینڈ وائٹ', twoSided: 'دونوں طرف', oneSided: 'ایک طرف', virtual: 'ورچوئل', isDefault: 'ڈیفالٹ',
    fetched: '{found} پرنٹر ملے۔ دکان میں شامل ہوئے: {added}۔ پہلے سے موجود: {existing}۔', limit: '{n} شامل نہیں ہوئے کیونکہ آپ کا پلان {max} پرنٹر کی اجازت دیتا ہے۔',
    virtualNote: '{n} ورچوئل پرنٹر (PDF، فیکس…) چھوڑ دیے گئے۔', addVirtual: 'ورچوئل پرنٹرز بھی شامل کریں', nothingNew: 'شامل کرنے کو کچھ نیا نہیں۔',
    jobs: 'حالیہ آرڈر', noJobs: 'ابھی کوئی آرڈر نہیں۔', printing: 'پرنٹ ہو رہا ہے', done: 'مکمل', failed: 'ناکام',
    settings: 'سیٹنگ', autoStart: 'کمپیوٹر چلتے ہی خود بخود شروع ہو', testMode: 'ٹیسٹ موڈ (اصل میں پرنٹ نہ کرے)', testForced: '(PRINT_DRY_RUN سے سیٹ)',
    dashboard: 'ڈیش بورڈ کھولیں', disconnect: 'اس کمپیوٹر کو الگ کریں', confirmDisconnect: 'اس کمپیوٹر کو اپنی دکان سے الگ کریں؟ یہاں آرڈر پرنٹ ہونا بند ہو جائیں گے۔',
    keepRunning: 'یہ ونڈو بند کرنے سے ایجنٹ ٹاسک بار میں چلتا رہتا ہے۔', lang: 'English',
  },
};

let state = null;
let lang = 'en';
let ui = { busy: false, error: null, fetchBusy: false, fetchMsg: null, showServer: false, server: '', code: '', virtualCount: 0 };
const t = (k, v = {}) => (T[lang][k] ?? T.en[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => v[n] ?? '');

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

function setLang(l) {
  lang = l;
  document.documentElement.lang = l;
  document.documentElement.dir = l === 'ur' ? 'rtl' : 'ltr';
}

const statusText = (s) => ({
  connected: [t('connectedTo', { shop: s.shopName ?? '' }), t('subConnected')],
  connecting: [t('connecting'), t('subConnecting')],
  disconnected: [t('disconnected'), t('subDisconnected')],
  unpaired: [t('notSetup'), t('subUnpaired')],
}[s.status]);

function header(s) {
  const [title, sub] = statusText(s);
  return h('div', { class: 'card' }, h('div', { class: `status ${s.status}` },
    h('div', { class: 'bigdot', 'aria-hidden': 'true' }),
    h('div', { style: 'flex:1' }, h('h1', { role: 'status' }, title), h('div', { class: 'muted' }, sub)),
    h('button', { class: 'lang', onclick: () => { api.setOption('lang', lang === 'ur' ? 'en' : 'ur'); setLang(lang === 'ur' ? 'en' : 'ur'); render(); } }, t('lang'))));
}

async function doPair() {
  const server = ui.server || state.defaultServer || '';
  if (!ui.code.trim()) { ui.error = t('needCode'); return render(); }
  ui.busy = true; ui.error = null; render();
  const r = await api.pair(server, ui.code);
  ui.busy = false;
  if (!r.ok) ui.error = r.error;
  else { ui.code = ''; ui.fetchMsg = summarize(r.sync); ui.virtualCount = r.sync?.virtualSkipped ?? 0; }
  render();
}

function summarize(r) {
  if (!r) return null;
  const parts = [r.added.length || r.existing.length ? t('fetched', { found: r.found, added: r.added.length, existing: r.existing.length }) : t('nothingNew')];
  if (r.skipped.length) parts.push(t('limit', { n: r.skipped.length, max: r.limit ?? '?' }));
  if (r.virtualSkipped) parts.push(t('virtualNote', { n: r.virtualSkipped }));
  return parts.join(' ');
}

async function doFetch(includeVirtual = false) {
  ui.fetchBusy = true; ui.fetchMsg = null; render();
  const r = await api.fetchPrinters({ includeVirtual });
  ui.fetchBusy = false;
  ui.fetchMsg = r.ok ? summarize(r.result) : r.error;
  ui.fetchBad = !r.ok;
  ui.virtualCount = r.ok ? r.result.virtualSkipped : ui.virtualCount;
  render();
}

function setupView() {
  const server = ui.server || state.defaultServer || '';
  return [
    header(state),
    h('div', { class: 'card' },
      h('h2', {}, t('connectTitle')),
      h('ol', { class: 'steps' }, h('li', {}, t('step1')), h('li', {}, t('step2'))),
      state.error ? h('div', { class: 'notice bad', style: 'margin-bottom:8px' }, state.error) : null,
      h('label', { for: 'code' }, t('code')),
      h('input', { id: 'code', class: 'code', type: 'text', placeholder: 'ABCD-EFGH', maxlength: 9, autocomplete: 'off', value: ui.code, disabled: ui.busy,
        oninput: (e) => { ui.code = e.target.value.toUpperCase(); }, onkeydown: (e) => { if (e.key === 'Enter') doPair(); } }),
      ui.showServer
        ? h('div', { style: 'margin-top:10px' }, h('label', { for: 'server' }, t('server')), h('input', { id: 'server', type: 'text', value: server, disabled: ui.busy, oninput: (e) => { ui.server = e.target.value; } }))
        : h('button', { class: 'btn link', onclick: () => { ui.showServer = true; render(); } }, `${t('server')}: ${server.replace(/^https?:\/\//, '')} · ${t('changeServer')}`),
      ui.error ? h('div', { class: 'notice bad', role: 'alert', style: 'margin-top:10px' }, ui.error) : null,
      ui.busy ? h('div', { class: 'notice info', style: 'margin-top:10px' }, t('connectingBusy')) : null,
      h('div', { style: 'margin-top:12px' }, h('button', { class: 'btn primary', disabled: ui.busy, onclick: doPair }, t('connect')))),
  ];
}

const jobLabel = { printing: ['printing', 'info'], done: ['done', 'ok'], failed: ['failed', 'bad'] };

function mainView() {
  const s = state;
  const real = s.printers.filter((p) => !p.virtual);
  return [
    header(s),
    h('div', { class: 'card' },
      h('button', { class: 'btn primary', disabled: ui.fetchBusy || s.status !== 'connected', onclick: () => doFetch(false) }, ui.fetchBusy ? t('fetching') : t('fetch')),
      ui.fetchMsg ? h('div', { class: `notice ${ui.fetchBad ? 'bad' : 'ok'}`, style: 'margin-top:10px', role: 'status' }, ui.fetchMsg) : null,
      (ui.virtualCount || s.printers.some((p) => p.virtual)) ? h('button', { class: 'btn link', disabled: ui.fetchBusy || s.status !== 'connected', onclick: () => doFetch(true) }, t('addVirtual')) : null),
    h('div', { class: 'card' }, h('h2', {}, t('printers')),
      s.printers.length ? s.printers.map((p) => h('div', { class: 'item' },
        h('div', {}, h('strong', {}, p.name), p.isDefault ? h('span', { class: 'chip' }, t('isDefault')) : null, p.virtual ? h('span', { class: 'chip' }, t('virtual')) : null),
        h('div', { class: 'small muted' }, `${p.color ? t('colour') : t('bw')} · ${p.duplex ? t('twoSided') : t('oneSided')}`)))
        : h('div', { class: 'muted' }, t('noPrinters')),
      real.length === 0 && s.printers.length ? null : null),
    h('div', { class: 'card' }, h('h2', {}, t('jobs')),
      s.recentJobs.length ? s.recentJobs.slice(0, 5).map((j) => {
        const [k, cls] = jobLabel[j.status] ?? ['done', ''];
        return h('div', { class: 'item' }, h('div', {}, h('strong', {}, `#${j.orderCode}`), ' ', h('span', { class: 'muted small' }, j.printer), j.error ? h('div', { class: 'small', style: 'color:var(--red)' }, j.error) : null),
          h('span', { class: `chip ${cls}` }, t(k)));
      }) : h('div', { class: 'muted' }, t('noJobs'))),
    h('div', { class: 'card' }, h('h2', {}, t('settings')),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.autoStart, onchange: (e) => api.setOption('autoStart', e.target.checked) }), t('autoStart')),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.testMode, disabled: s.testModeForced, onchange: (e) => api.setOption('testMode', e.target.checked) }), t('testMode'), s.testModeForced ? ` ${t('testForced')}` : ''),
      h('div', { class: 'row', style: 'margin-top:10px' },
        h('button', { class: 'btn', onclick: () => api.openDashboard() }, t('dashboard')),
        h('button', { class: 'btn danger', onclick: () => { if (confirm(t('confirmDisconnect'))) api.unpair(); } }, t('disconnect'))),
      h('p', { class: 'small muted', style: 'margin-top:10px' }, t('keepRunning'))),
  ];
}

function render() {
  if (!state) return;
  const focus = document.activeElement?.id;
  const pos = document.activeElement?.selectionStart;
  app.replaceChildren(...(state.paired ? mainView() : setupView()));
  if (focus && document.getElementById(focus)) {
    const el = document.getElementById(focus);
    el.focus();
    if (pos != null && el.setSelectionRange) try { el.setSelectionRange(pos, pos); } catch { /* not a text field */ }
  }
}

api.onState((s) => { state = s; if (s.paired) ui.error = null; render(); });
state = await api.getState();
setLang(state.lang ?? ((navigator.language || '').startsWith('ur') ? 'ur' : 'en'));
render();
