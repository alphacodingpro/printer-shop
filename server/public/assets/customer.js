import { h, api, clear, $, money, makeI18n, toast } from './common.js';

const T = {
  en: {
    loading: 'Loading…', notFound: 'We could not find this shop. Check the QR code and try again.',
    step1: 'Choose your file', pick: 'Tap to choose a file', pickHint: 'PDF, photo, Word, PowerPoint or Excel. Up to {mb} MB',
    uploading: 'Uploading…', pages: '{n} pages', page1: '1 page', change: 'Change file',
    step2: 'Print settings', mode: 'Colour', bw: 'Black & white', color: 'Colour', copies: 'Copies',
    sides: 'Sides', single: 'One side', double: 'Both sides', paper: 'Paper size', range: 'Pages',
    allPages: 'All pages', fromTo: 'Choose pages', from: 'From', to: 'To',
    step3: 'Pay', total: 'Total', pay: 'Pay now', payCash: 'Pay at the counter', payJazz: 'JazzCash', payEasy: 'Easypaisa', payMock: 'Test payment',
    chooseFirst: 'Choose a file and settings to see the price', calc: 'Calculating…',
    offline: 'Printer offline right now', closed: 'This shop is not taking orders right now.', ur: 'اردو', en: 'English',
    sheets: '{p} pages × {c} copies', needPay: 'Choose how you want to pay', payWith: 'Pay with {m}', howPay: 'How do you want to pay?', waitPrice: 'Choose your settings above to see the price',
  },
  ur: {
    loading: 'لوڈ ہو رہا ہے…', notFound: 'یہ دکان نہیں ملی۔ QR کوڈ دوبارہ چیک کریں۔',
    step1: 'اپنی فائل چنیں', pick: 'فائل چننے کے لیے دبائیں', pickHint: 'PDF، تصویر، ورڈ، پاور پوائنٹ یا ایکسل۔ زیادہ سے زیادہ {mb} MB',
    uploading: 'اپ لوڈ ہو رہی ہے…', pages: '{n} صفحات', page1: '1 صفحہ', change: 'فائل بدلیں',
    step2: 'پرنٹ کی سیٹنگ', mode: 'رنگ', bw: 'بلیک اینڈ وائٹ', color: 'رنگین', copies: 'کاپیاں',
    sides: 'طرف', single: 'ایک طرف', double: 'دونوں طرف', paper: 'کاغذ کا سائز', range: 'صفحات',
    allPages: 'تمام صفحات', fromTo: 'صفحات چنیں', from: 'سے', to: 'تک',
    step3: 'ادائیگی', total: 'کل', pay: 'ابھی ادائیگی کریں', payCash: 'کاؤنٹر پر ادائیگی', payJazz: 'جاز کیش', payEasy: 'ایزی پیسہ', payMock: 'ٹیسٹ ادائیگی',
    chooseFirst: 'قیمت دیکھنے کے لیے فائل اور سیٹنگ چنیں', calc: 'حساب ہو رہا ہے…',
    offline: 'پرنٹر ابھی بند ہے', closed: 'یہ دکان ابھی آرڈر نہیں لے رہی۔', ur: 'اردو', en: 'English',
    sheets: '{p} صفحات × {c} کاپیاں', needPay: 'ادائیگی کا طریقہ چنیں', payWith: '{m} سے ادائیگی کریں', howPay: 'آپ کیسے ادائیگی کرنا چاہتے ہیں؟', waitPrice: 'قیمت دیکھنے کے لیے اوپر سیٹنگ چنیں',
  },
};
const i18n = makeI18n(T);
const t = i18n.t;
const slug = decodeURIComponent(location.pathname.split('/')[2] || '');
const app = $('#app');

const S = { shop: null, orderId: null, file: null, opts: { colorMode: null, copies: 1, sides: 'single', paperSize: 'A4', pageFrom: '', pageTo: '' },
  quote: null, quoteErr: null, busy: false, uploading: false };
let quoteTimer;

async function ensureOrder() {
  if (!S.orderId) S.orderId = (await api(`/api/public/shops/${encodeURIComponent(slug)}/orders`, { method: 'POST', json: {} })).orderId;
  return S.orderId;
}

async function upload(file) {
  S.uploading = true; S.quote = null; S.quoteErr = null; render();
  try {
    const id = await ensureOrder();
    const fd = new FormData();
    fd.append('file', file, file.name);
    S.file = await api(`/api/public/orders/${id}/file`, { method: 'POST', form: fd });
    S.file.ext = (file.name.split('.').pop() || '').slice(0, 4).toUpperCase();
    S.opts.pageFrom = ''; S.opts.pageTo = '';
    if (!S.opts.colorMode) S.opts.colorMode = 'bw';
    requote();
  } catch (e) { toast(e.message, true); }
  S.uploading = false; render();
}

function requote() {
  clearTimeout(quoteTimer);
  if (!S.file) return;
  S.quote = null; S.quoteErr = null; S.calc = true; render();
  quoteTimer = setTimeout(async () => {
    try {
      S.quote = await api(`/api/public/orders/${S.orderId}/options`, { method: 'PATCH', json: S.opts });
    } catch (e) { S.quoteErr = e.message; }
    S.calc = false; render();
  }, 350);
}

async function pay(method) {
  S.busy = true; render();
  try {
    const r = await api(`/api/public/orders/${S.orderId}/pay`, { method: 'POST', json: { method } });
    if (r.kind === 'cash') location.href = `/o/${S.orderId}`;
    else if (r.kind === 'redirect') location.href = r.url;
    else if (r.kind === 'form') {
      const form = h('form', { method: r.method, action: r.action });
      for (const [k, v] of Object.entries(r.fields)) form.append(h('input', { type: 'hidden', name: k, value: v }));
      document.body.append(form);
      form.submit();
    }
  } catch (e) { toast(e.message, true); S.busy = false; render(); }
}

const pressed = (on) => (on ? 'true' : 'false');

function render() {
  if (!S.shop) return;
  const s = S.shop;
  const methodLabel = { jazzcash: t('payJazz'), easypaisa: t('payEasy'), cash: t('payCash'), mock: t('payMock') };
  const sizes = (s.paperSizes.length ? s.paperSizes : ['A4']).filter((z) => s.pricing.some((p) => p.paper_size === z));
  const canPay = S.quote && !S.calc && !S.busy;

  const fileInput = h('input', { type: 'file', accept: '.pdf,.jpg,.jpeg,.png,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.odt,.rtf,application/pdf,image/*',
    onchange: (e) => e.target.files[0] && upload(e.target.files[0]) });

  const fileCard = h('section', { class: 'card' },
    h('h2', {}, t('step1')),
    S.uploading ? h('p', { class: 'muted' }, t('uploading'))
    : S.file ? h('div', { class: 'fileinfo' },
        h('div', { class: 'ext', 'aria-hidden': 'true' }, S.file.ext || 'PDF'),
        h('div', { class: 'grow' }, h('strong', { style: 'word-break:break-all' }, S.file.fileName), h('div', { class: 'muted small' }, S.file.pages === 1 ? t('page1') : t('pages', { n: S.file.pages }))),
        h('label', { class: 'btn small', style: 'margin:0;position:relative' }, t('change'), fileInput))
    : h('label', { class: 'drop', style: 'position:relative' }, h('strong', {}, t('pick')), h('span', { class: 'muted small' }, t('pickHint', { mb: s.maxFileMb })), fileInput));

  const sec2 = S.file && h('section', { class: 'card stack' },
    h('h2', {}, t('step2')),
    h('div', {},
      h('label', {}, t('mode')),
      h('div', { class: 'modes' },
        h('button', { class: 'mode', type: 'button', 'aria-pressed': pressed(S.opts.colorMode === 'bw'), onclick: () => { S.opts.colorMode = 'bw'; requote(); } },
          h('span', { class: 'inks', 'aria-hidden': 'true' }, h('i', { class: 'k' })), h('strong', {}, t('bw'))),
        h('button', { class: 'mode', type: 'button', disabled: !s.colorAvailable, 'aria-pressed': pressed(S.opts.colorMode === 'color'), onclick: () => { S.opts.colorMode = 'color'; requote(); } },
          h('span', { class: 'inks', 'aria-hidden': 'true' }, h('i', { class: 'c' }), h('i', { class: 'm' }), h('i', { class: 'y' })), h('strong', {}, t('color'))))),
    h('div', { class: 'grid2' },
      h('div', {}, h('label', {}, t('copies')),
        h('input', { type: 'number', min: 1, max: 500, inputmode: 'numeric', value: S.opts.copies, onchange: (e) => { S.opts.copies = Math.max(1, Math.min(500, parseInt(e.target.value, 10) || 1)); requote(); } })),
      h('div', {}, h('label', {}, t('paper')),
        h('select', { onchange: (e) => { S.opts.paperSize = e.target.value; requote(); } }, sizes.map((z) => h('option', { value: z, selected: z === S.opts.paperSize }, z))))),
    h('div', {}, h('label', {}, t('sides')),
      h('div', { class: 'seg' },
        h('button', { type: 'button', 'aria-pressed': pressed(S.opts.sides === 'single'), onclick: () => { S.opts.sides = 'single'; requote(); } }, t('single')),
        h('button', { type: 'button', disabled: !s.duplexAvailable, 'aria-pressed': pressed(S.opts.sides === 'double'), onclick: () => { S.opts.sides = 'double'; requote(); } }, t('double')))),
    h('div', {}, h('label', {}, t('range')),
      h('div', { class: 'seg' },
        h('button', { type: 'button', 'aria-pressed': pressed(!S.ranged), onclick: () => { S.ranged = false; S.opts.pageFrom = ''; S.opts.pageTo = ''; requote(); } }, t('allPages')),
        h('button', { type: 'button', 'aria-pressed': pressed(!!S.ranged), onclick: () => { S.ranged = true; S.opts.pageFrom = 1; S.opts.pageTo = S.file.pages; requote(); } }, t('fromTo'))),
      S.ranged && h('div', { class: 'grid2', style: 'margin-top:10px' },
        h('div', {}, h('label', {}, t('from')), h('input', { type: 'number', min: 1, max: S.file.pages, inputmode: 'numeric', value: S.opts.pageFrom, onchange: (e) => { S.opts.pageFrom = e.target.value; requote(); } })),
        h('div', {}, h('label', {}, t('to')), h('input', { type: 'number', min: 1, max: S.file.pages, inputmode: 'numeric', value: S.opts.pageTo, onchange: (e) => { S.opts.pageTo = e.target.value; requote(); } })))));

  const payLabel = { cash: t('payCash'), jazzcash: t('payWith', { m: t('payJazz') }), easypaisa: t('payWith', { m: t('payEasy') }), mock: t('payMock') };
  const sec3 = S.file && h('section', { class: 'card stack' },
    h('h2', {}, t('step3')),
    S.quoteErr && h('div', { class: 'notice bad', role: 'alert' }, S.quoteErr),
    !S.quote && !S.quoteErr && h('p', { class: 'muted' }, S.calc ? t('calc') : t('waitPrice')),
    S.quote && h('p', { class: 'muted', style: 'margin:0' }, t('howPay')),
    ...s.paymentMethods.map((m) =>
      h('button', { class: m === 'cash' ? 'btn' : 'btn primary', type: 'button', disabled: !canPay,
        onclick: () => pay(m) }, S.busy ? '…' : payLabel[m] || m)));

  const ready = !!S.quote;
  clear(app).append(
    h('div', { class: 'row between', style: 'margin-bottom:12px' },
      h('div', {}, h('h1', { style: 'margin:0' }, s.name), s.city && h('div', { class: 'muted small' }, s.city)),
      h('button', { class: 'lang', type: 'button', onclick: () => { i18n.toggle(); render(); } }, i18n.lang === 'ur' ? t('en') : t('ur'))),
    s.closedReason ? h('div', { class: 'notice bad' }, t('closed')) : null,
    !s.closedReason && s.printersOnline === 0 ? h('div', { class: 'notice' }, t('offline')) : null,
    h('ol', { class: 'stepper', 'aria-hidden': 'true' }, h('li', { class: S.file ? 'done' : '' }), h('li', { class: ready ? 'done' : '' }), h('li', { class: S.busy ? 'done' : '' })),
    !s.closedReason && fileCard, sec2, sec3,
    S.file && h('div', { class: 'bar' }, h('div', { class: 'in' },
      h('div', {},
        h('div', { class: 'muted small' }, t('total')),
        h('div', { class: 'price', 'aria-live': 'polite' }, S.calc ? '…' : S.quote ? money(S.quote.amount) : '—'),
        S.quote && h('div', { class: 'muted small' }, t('sheets', { p: S.quote.pages, c: S.quote.copies }))),
      null))
  );
}

try {
  S.shop = await api(`/api/public/shops/${encodeURIComponent(slug)}`);
  document.title = S.shop.name;
  if (!S.shop.colorAvailable) S.opts.colorMode = 'bw';
  render();
} catch (e) {
  clear(app).append(h('div', { class: 'notice bad' }, e.status === 404 ? t('notFound') : e.message));
}
