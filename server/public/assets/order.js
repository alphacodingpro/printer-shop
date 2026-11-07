import { h, api, clear, $, money, makeI18n } from './common.js';

const T = {
  en: { code: 'Your order code', paid: 'Paid', printing: 'Printing', done: 'Ready', pay: 'Pay', waitCash: 'Pay Rs {amt} at the counter and show this code. Printing starts as soon as the shop confirms.',
    sent: 'Your file is in the print queue.', printingNow: 'Your file is printing. Please collect it at the counter.', ready: 'Done! Please collect your prints at the counter.',
    problem: 'Something went wrong with this order. Please show this code at the counter and the shop will help you.', cancelled: 'This order was cancelled.', expired: 'This order expired. Scan the QR code again to start a new one.',
    unpaid: 'Waiting for payment', notFound: 'Order not found.', again: 'Print another file', ur: 'اردو', en: 'English', file: 'File', details: '{p} pages, {c} copies' },
  ur: { code: 'آپ کا آرڈر کوڈ', paid: 'ادا ہو گیا', printing: 'پرنٹ ہو رہا ہے', done: 'تیار', pay: 'ادائیگی', waitCash: 'کاؤنٹر پر Rs {amt} ادا کریں اور یہ کوڈ دکھائیں۔ دکاندار کی تصدیق کے بعد پرنٹنگ شروع ہو جائے گی۔',
    sent: 'آپ کی فائل پرنٹ کی قطار میں ہے۔', printingNow: 'آپ کی فائل پرنٹ ہو رہی ہے۔ براہ کرم کاؤنٹر سے وصول کریں۔', ready: 'مکمل! براہ کرم کاؤنٹر سے اپنے پرنٹ لے لیں۔',
    problem: 'اس آرڈر میں مسئلہ آ گیا ہے۔ براہ کرم یہ کوڈ کاؤنٹر پر دکھائیں، دکاندار آپ کی مدد کرے گا۔', cancelled: 'یہ آرڈر منسوخ ہو گیا۔', expired: 'یہ آرڈر ختم ہو گیا۔ نیا آرڈر شروع کرنے کے لیے دوبارہ QR اسکین کریں۔',
    unpaid: 'ادائیگی کا انتظار', notFound: 'آرڈر نہیں ملا۔', again: 'ایک اور فائل پرنٹ کریں', ur: 'اردو', en: 'English', file: 'فائل', details: '{p} صفحات، {c} کاپیاں' },
};
const i18n = makeI18n(T);
const t = i18n.t;
const id = location.pathname.split('/').pop();
const app = $('#app');
let timer;

function render(o) {
  const step = { awaiting_payment: 0, paid: 1, printing: 2, completed: 3 }[o.status] ?? 0;
  const final = ['completed', 'failed', 'cancelled', 'expired'].includes(o.status);
  let msg = null; let kind = 'info';
  if (o.awaitingCash) msg = t('waitCash', { amt: o.amount });
  else if (o.status === 'paid') msg = t('sent');
  else if (o.status === 'printing') msg = t('printingNow');
  else if (o.status === 'completed') { msg = t('ready'); kind = 'ok'; }
  else if (o.status === 'failed') { msg = t('problem'); kind = 'bad'; }
  else if (o.status === 'cancelled') { msg = t('cancelled'); kind = 'bad'; }
  else if (o.status === 'expired') { msg = t('expired'); kind = 'bad'; }
  else msg = t('unpaid');

  clear(app).append(
    h('div', { class: 'row between', style: 'margin-bottom:12px' },
      h('strong', {}, o.shop.name),
      h('button', { class: 'lang', type: 'button', onclick: () => { i18n.toggle(); render(o); } }, i18n.lang === 'ur' ? t('en') : t('ur'))),
    h('div', { class: 'ticket' },
      h('div', { class: 'muted small' }, t('code')),
      h('div', { class: 'code' }, o.code),
      o.amount != null && h('div', { class: 'muted' }, `${money(o.amount)} · ${t('details', { p: o.pages, c: o.copies })}`),
      !['failed', 'cancelled', 'expired'].includes(o.status) && h('ol', { class: 'track' },
        h('li', { class: step >= 1 ? 'done' : step === 0 ? 'now' : '' }, step >= 1 ? t('paid') : t('pay')),
        h('li', { class: step >= 3 ? 'done' : step >= 1 ? 'now' : '' }, t('printing')),
        h('li', { class: step >= 3 ? 'done now' : '' }, t('done')))),
    h('div', { class: `notice ${kind}`, style: 'margin-top:14px', role: 'status' }, msg),
    final && h('p', { style: 'margin-top:14px' }, h('a', { class: 'btn', href: `/s/${o.shop.slug}` }, t('again')))
  );
  clearTimeout(timer);
  if (!final) timer = setTimeout(poll, 2500);
}

async function poll() {
  try { render(await api(`/api/public/orders/${id}`)); }
  catch (e) {
    if (e.status === 404) clear(app).append(h('div', { class: 'notice bad' }, t('notFound')));
    else timer = setTimeout(poll, 5000);
  }
}
poll();
