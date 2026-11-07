// Payment gateway return/callback endpoints. Every request is verified before an order is marked paid.
import { Router } from 'express';
import express from 'express';
import { q } from '../db.js';
import { wrap } from '../errors.js';
import { decrypt } from '../crypto.js';
import { config } from '../config.js';
import { markPaid, markFailed } from '../payments.js';
import { providers } from '../providers/index.js';
import { confirmUrl, inquire } from '../providers/easypaisa.js';

const router = Router();
router.use(express.urlencoded({ extended: false, limit: '50kb' }));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadContext(req, provider) {
  const { shopId } = req.params;
  const pid = String(req.query.p ?? '');
  if (!UUID_RE.test(shopId) || !UUID_RE.test(pid)) return null;
  const pay = (await q(`SELECT * FROM payments WHERE id = $1 AND shop_id = $2 AND provider = $3`, [pid, shopId, provider])).rows[0];
  if (!pay) return null;
  const acct = (await q(`SELECT credentials_encrypted FROM shop_payment_accounts WHERE shop_id = $1 AND provider = $2`, [shopId, provider])).rows[0];
  if (!acct?.credentials_encrypted) return null;
  try {
    return { payment: pay, creds: decrypt(acct.credentials_encrypted) };
  } catch {
    return null;
  }
}

const backToOrder = (res, orderId) => res.redirect(303, `/o/${orderId}`);

router.all('/jazzcash/:shopId', wrap(async (req, res) => {
  const ctx = await loadContext(req, 'jazzcash');
  if (!ctx) return res.status(400).send('Invalid payment reference');
  const params = { ...req.query, ...req.body };
  delete params.p;
  const result = providers.jazzcash.verifyReturn({ params, creds: ctx.creds, payment: ctx.payment });
  if (!result.ok) {
    console.warn(`JazzCash callback rejected (${result.reason}) for payment ${ctx.payment.id}`);
  } else if (result.paid) {
    await markPaid({ paymentId: ctx.payment.id, providerTxnId: result.txnId, raw: params });
  } else {
    await markFailed({ paymentId: ctx.payment.id, raw: params });
  }
  backToOrder(res, ctx.payment.order_id);
}));

router.all('/easypaisa/:shopId', wrap(async (req, res) => {
  const ctx = await loadContext(req, 'easypaisa');
  if (!ctx) return res.status(400).send('Invalid payment reference');
  const params = { ...req.query, ...req.body };
  const selfUrl = `${config.publicUrl}/api/webhooks/easypaisa/${req.params.shopId}?p=${ctx.payment.id}`;

  // Leg 1: Easypaisa returns an auth_token that must be confirmed with a redirect.
  if (params.auth_token && !params.status) return res.redirect(302, confirmUrl(ctx.creds, String(params.auth_token), selfUrl));

  // Leg 2: never trust the browser. Ask Easypaisa server-to-server whether this order is PAID.
  try {
    const r = await inquire({ creds: ctx.creds, payment: ctx.payment });
    if (r.ok && r.paid) await markPaid({ paymentId: ctx.payment.id, providerTxnId: r.txnId, raw: r.raw });
    else if (!r.ok) console.warn(`Easypaisa inquiry failed (${r.reason}) for payment ${ctx.payment.id}`);
  } catch (e) {
    console.warn('Easypaisa inquiry error:', e.message);
  }
  backToOrder(res, ctx.payment.order_id);
}));

// ---- Mock gateway: local testing only ----
router.get('/mock/:paymentId', (_req, res) => res.status(404).end());
router.post('/mock/:paymentId', wrap(async (req, res) => {
  if (!config.enableMockPayments) return res.status(404).end();
  if (!UUID_RE.test(req.params.paymentId)) return res.status(404).end();
  const pay = (await q(`SELECT * FROM payments WHERE id = $1 AND provider = 'mock'`, [req.params.paymentId])).rows[0];
  if (!pay) return res.status(404).end();
  if (req.body?.result === 'success') await markPaid({ paymentId: pay.id, providerTxnId: `MOCK-${pay.id}` });
  else await markFailed({ paymentId: pay.id });
  backToOrder(res, pay.order_id);
}));

export default router;
