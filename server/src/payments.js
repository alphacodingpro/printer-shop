import { q, tx } from './db.js';
import { HttpError } from './errors.js';
import { dispatchJob } from './hub.js';
import { randomToken } from './crypto.js';

export async function createPayment(db, { order, provider }) {
  const txnRef = provider === 'cash' ? null : `T${Date.now().toString(36).toUpperCase()}${randomToken(4).toUpperCase()}`;
  const r = await db.query(
    `INSERT INTO payments (order_id, shop_id, provider, txn_ref, amount) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [order.id, order.shop_id, provider, txnRef, order.amount]
  );
  return r.rows[0];
}

/**
 * Marks a payment (and its order) as paid and queues the print job. Idempotent:
 * calling it twice for the same payment never creates a second print job.
 */
export async function markPaid({ paymentId, providerTxnId = null, raw = null }) {
  const jobId = await tx(async (c) => {
    const p = (await c.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId])).rows[0];
    if (!p) throw new HttpError(404, 'Payment not found');
    if (p.status === 'paid') return null;

    const o = (await c.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [p.order_id])).rows[0];
    await c.query(
      `UPDATE payments SET status = 'paid', provider_txn_id = $2, raw_callback = $3, verified_at = now() WHERE id = $1`,
      [p.id, providerTxnId, raw ? JSON.stringify(raw) : null]
    );
    if (o.payment_status === 'paid') return null;

    const file = (await c.query('SELECT 1 FROM order_files WHERE order_id = $1 AND deleted_at IS NULL', [o.id])).rows[0];
    const amountMatches = Number(p.amount) === Number(o.amount); // guards against changing options after paying
    const printable = ['awaiting_payment', 'expired'].includes(o.status) && file && o.printer_id && amountMatches;
    if (!printable) {
      // Money was received but we cannot print (cancelled / file gone). Flag it for the shop to refund.
      await c.query(
        `UPDATE orders SET payment_status = 'paid', paid_at = now(), payment_method = $2, status = 'failed', failure_reason = $3 WHERE id = $1`,
        [o.id, p.provider, amountMatches ? 'paid_but_cannot_print' : 'paid_amount_mismatch']
      );
      return null;
    }
    await c.query(
      `UPDATE orders SET status = 'paid', payment_status = 'paid', paid_at = now(), payment_method = $2, failure_reason = NULL WHERE id = $1`,
      [o.id, p.provider]
    );
    await c.query(`UPDATE order_files SET delete_after = NULL WHERE order_id = $1`, [o.id]);
    const j = await c.query(
      `INSERT INTO print_jobs (order_id, shop_id, printer_id) VALUES ($1, $2, $3)
       ON CONFLICT (order_id) DO NOTHING RETURNING id`,
      [o.id, o.shop_id, o.printer_id]
    );
    return j.rows[0]?.id ?? null;
  });
  if (jobId) await dispatchJob(jobId);
  return jobId;
}

export async function markFailed({ paymentId, raw = null }) {
  await q(
    `UPDATE payments SET status = 'failed', raw_callback = $2 WHERE id = $1 AND status = 'pending'`,
    [paymentId, raw ? JSON.stringify(raw) : null]
  );
}
