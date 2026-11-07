// JazzCash "Hosted Checkout" (page redirection) adapter.
//
// IMPORTANT: written from JazzCash's public integration guide. Test it against the
// JazzCash SANDBOX with your own merchant credentials before going live, and compare
// field names with the guide you receive from JazzCash (they do change versions).
//
// Credentials JSON per shop: { merchantId, password, integritySalt, sandbox: boolean }
import crypto from 'node:crypto';

const URLS = {
  sandbox: 'https://sandbox.jazzcash.com.pk/CustomerPortal/transactionmanagement/merchantform/',
  live: 'https://payments.jazzcash.com.pk/CustomerPortal/transactionmanagement/merchantform/',
};
export const FORM_HOSTS = ['https://sandbox.jazzcash.com.pk', 'https://payments.jazzcash.com.pk'];

export const REQUIRED = ['merchantId', 'password', 'integritySalt'];

// Pakistan time (UTC+5) formatted yyyyMMddHHmmss
function pkt(date) {
  const d = new Date(date.getTime() + 5 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

export function secureHash(fields, salt) {
  const keys = Object.keys(fields)
    .filter((k) => k !== 'pp_SecureHash' && fields[k] !== '' && fields[k] != null)
    .sort();
  const str = [salt, ...keys.map((k) => fields[k])].join('&');
  return crypto.createHmac('sha256', salt).update(str).digest('hex').toUpperCase();
}

export function createCheckout({ payment, order, creds, returnUrl }) {
  const now = new Date();
  const fields = {
    pp_Version: '1.1',
    pp_TxnType: '',
    pp_Language: 'EN',
    pp_MerchantID: creds.merchantId,
    pp_SubMerchantID: '',
    pp_Password: creds.password,
    pp_BankID: '',
    pp_ProductID: '',
    pp_TxnRefNo: payment.txn_ref,
    pp_Amount: String(Math.round(order.amount * 100)), // paisa
    pp_TxnCurrency: 'PKR',
    pp_TxnDateTime: pkt(now),
    pp_BillReference: `order${order.public_code}`,
    pp_Description: `Print order ${order.public_code}`,
    pp_TxnExpiryDateTime: pkt(new Date(now.getTime() + 60 * 60 * 1000)),
    pp_ReturnURL: returnUrl,
    ppmpf_1: '',
    ppmpf_2: '',
    ppmpf_3: '',
    ppmpf_4: '',
    ppmpf_5: '',
  };
  fields.pp_SecureHash = secureHash(fields, creds.integritySalt);
  return { kind: 'form', action: creds.sandbox ? URLS.sandbox : URLS.live, method: 'POST', fields };
}

/** Verifies the gateway's return POST. Returns { ok, paid, txnId, amount } */
export function verifyReturn({ params, creds, payment }) {
  const received = String(params.pp_SecureHash || '').toUpperCase();
  const expected = secureHash(params, creds.integritySalt);
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  const hashOk = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!hashOk) return { ok: false, reason: 'bad_signature' };
  if (params.pp_TxnRefNo !== payment.txn_ref) return { ok: false, reason: 'ref_mismatch' };
  const amountOk = Number(params.pp_Amount) === Math.round(payment.amount * 100);
  if (!amountOk) return { ok: false, reason: 'amount_mismatch' };
  return {
    ok: true,
    paid: params.pp_ResponseCode === '000',
    txnId: params.pp_RetreivalReferenceNo || params.pp_TxnRefNo,
  };
}
