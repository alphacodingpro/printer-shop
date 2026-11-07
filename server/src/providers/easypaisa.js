// Easypaisa "Easypay" hosted checkout adapter.
//
// IMPORTANT / READ ME: this adapter follows Easypaisa's hosted-checkout flow as best
// documented publicly, but their parameter names differ between merchant onboarding
// kits. It is DISABLED FOR REAL MONEY until you have verified it in the Easypaisa
// sandbox with your own store. It deliberately FAILS CLOSED: an order is only marked
// paid after a server-to-server "inquire transaction" call confirms status PAID.
// A customer who forges the browser return URL therefore cannot get free prints.
//
// Credentials JSON per shop:
//   { storeId, hashKey, accountNum, username, password, sandbox: boolean }
//   hashKey            -> 16 chars, used to encrypt merchantHashedReq (AES-128-ECB)
//   username/password  -> used for the inquire-transaction API ("Credentials" header)
import crypto from 'node:crypto';

const URLS = {
  sandbox: {
    checkout: 'https://easypaystg.easypaisa.com.pk/easypay/Index.jsf',
    confirm: 'https://easypaystg.easypaisa.com.pk/easypay/Confirm.jsf',
    inquire: 'https://easypaystg.easypaisa.com.pk/easypay-service/rest/v4/inquire-transaction',
  },
  live: {
    checkout: 'https://easypay.easypaisa.com.pk/easypay/Index.jsf',
    confirm: 'https://easypay.easypaisa.com.pk/easypay/Confirm.jsf',
    inquire: 'https://easypay.easypaisa.com.pk/easypay-service/rest/v4/inquire-transaction',
  },
};
export const FORM_HOSTS = ['https://easypaystg.easypaisa.com.pk', 'https://easypay.easypaisa.com.pk'];
export const REQUIRED = ['storeId', 'hashKey', 'accountNum', 'username', 'password'];

function expiry(minutes) {
  const d = new Date(Date.now() + 5 * 3600 * 1000 + minutes * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())} ${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function hashedRequest(fields, hashKey) {
  const str = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('&');
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(hashKey, 'utf8'), null);
  return Buffer.concat([cipher.update(str, 'utf8'), cipher.final()]).toString('base64');
}

export function createCheckout({ payment, order, creds, returnUrl }) {
  const fields = {
    storeId: creds.storeId,
    amount: Number(order.amount).toFixed(1),
    postBackURL: returnUrl,
    orderRefNum: payment.txn_ref,
    expiryDate: expiry(60),
    autoRedirect: '1',
    paymentMethod: 'MA_PAYMENT_METHOD',
  };
  fields.merchantHashedReq = hashedRequest(fields, creds.hashKey);
  const urls = creds.sandbox ? URLS.sandbox : URLS.live;
  return { kind: 'form', action: urls.checkout, method: 'POST', fields };
}

export const confirmUrl = (creds, authToken, postBackURL) => {
  const u = new URL((creds.sandbox ? URLS.sandbox : URLS.live).confirm);
  u.searchParams.set('auth_token', authToken);
  u.searchParams.set('postBackURL', postBackURL);
  return u.toString();
};

/** Server-to-server confirmation. Only returns paid:true on an explicit PAID status. */
export async function inquire({ creds, payment }) {
  const urls = creds.sandbox ? URLS.sandbox : URLS.live;
  const res = await fetch(urls.inquire, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Credentials: Buffer.from(`${creds.username}:${creds.password}`).toString('base64'),
    },
    body: JSON.stringify({ orderId: payment.txn_ref, storeId: creds.storeId, accountNum: creds.accountNum }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return { ok: false, paid: false, reason: `inquire_http_${res.status}` };
  const body = await res.json().catch(() => ({}));
  const paid = String(body.transactionStatus || '').toUpperCase() === 'PAID';
  const amountOk = body.transactionAmount == null || Math.abs(Number(body.transactionAmount) - payment.amount) < 0.01;
  return { ok: true, paid: paid && amountOk, txnId: body.transactionId || payment.txn_ref, raw: body };
}
