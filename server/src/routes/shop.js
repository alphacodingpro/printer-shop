// Shop dashboard API (requires a shop login).
import { Router } from 'express';
import { q, tx } from '../db.js';
import { HttpError, wrap } from '../errors.js';
import { requireShop, requireOwner, hashPassword } from '../auth.js';
import { config } from '../config.js';
import { encrypt, pairingCode } from '../crypto.js';
import { isAgentOnline, dispatchJob } from '../hub.js';
import { markPaid } from '../payments.js';
import { requiredFields } from '../providers/index.js';

const router = Router();
router.use(requireShop);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIZES = ['A4', 'A3', 'A5', 'Legal', 'Letter'];
const id = (v) => {
  if (!UUID_RE.test(String(v))) throw new HttpError(404, 'Not found');
  return v;
};

router.get('/me', wrap(async (req, res) => {
  const s = (
    await q(
      `SELECT s.id, s.name, s.slug, s.phone, s.address, s.city, s.status, s.timezone,
              sub.status AS sub_status, sub.current_period_end, pl.name AS plan_name, pl.max_printers, pl.max_orders_per_month
         FROM shops s LEFT JOIN subscriptions sub ON sub.shop_id = s.id LEFT JOIN plans pl ON pl.id = sub.plan_id
        WHERE s.id = $1`,
      [req.user.shopId]
    )
  ).rows[0];
  res.json({ role: req.user.role, shop: s, shopUrl: `${config.publicUrl}/s/${s.slug}`, qrUrl: `/qr/${s.slug}.png`, agentDownloadUrl: config.agentDownloadUrl });
}));

router.patch('/me', requireOwner, wrap(async (req, res) => {
  const { name, phone, address, city } = req.body ?? {};
  if (name != null && String(name).trim().length < 2) throw new HttpError(400, 'Enter your shop name');
  await q(
    `UPDATE shops SET name = COALESCE($2, name), phone = COALESCE($3, phone), address = COALESCE($4, address), city = COALESCE($5, city) WHERE id = $1`,
    [req.user.shopId, name ? String(name).trim().slice(0, 120) : null, phone != null ? String(phone).slice(0, 30) : null, address != null ? String(address).slice(0, 200) : null, city != null ? String(city).slice(0, 80) : null]
  );
  res.json({ ok: true });
}));

router.get('/stats', wrap(async (req, res) => {
  const r = await q(
    `SELECT
       count(*) FILTER (WHERE (o.created_at AT TIME ZONE sh.timezone)::date = (now() AT TIME ZONE sh.timezone)::date)::int AS orders_today,
       COALESCE(sum(o.amount) FILTER (WHERE o.payment_status = 'paid' AND (o.paid_at AT TIME ZONE sh.timezone)::date = (now() AT TIME ZONE sh.timezone)::date), 0) AS revenue_today,
       count(*) FILTER (WHERE o.status = 'awaiting_payment' AND o.payment_method = 'cash')::int AS awaiting_cash,
       count(*) FILTER (WHERE o.status = 'failed' AND o.created_at > now() - interval '7 days')::int AS failed_recent,
       count(*) FILTER (WHERE o.status IN ('paid', 'printing'))::int AS in_progress
     FROM orders o JOIN shops sh ON sh.id = o.shop_id WHERE o.shop_id = $1`,
    [req.user.shopId]
  );
  res.json(r.rows[0]);
}));

// ---------- Orders ----------
router.get('/orders', wrap(async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const r = await q(
    `SELECT o.id, o.public_code, o.status, o.payment_status, o.payment_method, o.amount, o.total_pages, o.copies, o.color_mode,
            o.sides, o.paper_size, o.page_from, o.page_to, o.customer_phone, o.failure_reason, o.created_at, o.paid_at,
            f.original_name AS file_name, f.deleted_at AS file_deleted_at, p.display_name AS printer_name
       FROM orders o
       LEFT JOIN order_files f ON f.order_id = o.id
       LEFT JOIN printers p ON p.id = o.printer_id
      WHERE o.shop_id = $1 AND o.status <> 'draft' AND ($2::text IS NULL OR o.status::text = $2)
      ORDER BY o.created_at DESC LIMIT $3 OFFSET $4`,
    [req.user.shopId, status, limit, offset]
  );
  res.json(r.rows);
}));

async function ownOrder(req) {
  const o = (await q('SELECT * FROM orders WHERE id = $1 AND shop_id = $2', [id(req.params.id), req.user.shopId])).rows[0];
  if (!o) throw new HttpError(404, 'Order not found');
  return o;
}

router.post('/orders/:id/mark-paid', wrap(async (req, res) => {
  const o = await ownOrder(req);
  if (o.status !== 'awaiting_payment' || o.payment_method !== 'cash') throw new HttpError(409, 'This order is not waiting for a cash payment');
  const pay = (await q(`SELECT id FROM payments WHERE order_id = $1 AND provider = 'cash' AND status = 'pending' ORDER BY created_at DESC LIMIT 1`, [o.id])).rows[0];
  if (!pay) throw new HttpError(409, 'No cash payment found for this order');
  await markPaid({ paymentId: pay.id });
  res.json({ ok: true });
}));

router.post('/orders/:id/cancel', wrap(async (req, res) => {
  const o = await ownOrder(req);
  if (o.payment_status === 'paid' && o.status !== 'failed') throw new HttpError(409, 'A paid order cannot be cancelled. Use refund for failed orders');
  await tx(async (c) => {
    await c.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [o.id]);
    await c.query(`UPDATE payments SET status = 'failed' WHERE order_id = $1 AND status = 'pending'`, [o.id]);
    await c.query(`UPDATE order_files SET delete_after = now() WHERE order_id = $1`, [o.id]);
  });
  res.json({ ok: true });
}));

// Records that the shop returned the money manually (outside this app).
router.post('/orders/:id/refund', wrap(async (req, res) => {
  const o = await ownOrder(req);
  if (o.payment_status !== 'paid' || o.status !== 'failed') throw new HttpError(409, 'Only paid orders that failed can be marked as refunded');
  await tx(async (c) => {
    await c.query(`UPDATE orders SET status = 'cancelled', payment_status = 'refunded' WHERE id = $1`, [o.id]);
    await c.query(`UPDATE payments SET status = 'refunded' WHERE order_id = $1 AND status = 'paid'`, [o.id]);
    await c.query(`UPDATE order_files SET delete_after = now() WHERE order_id = $1`, [o.id]);
  });
  res.json({ ok: true });
}));

router.post('/orders/:id/reprint', wrap(async (req, res) => {
  const o = await ownOrder(req);
  if (o.payment_status !== 'paid' || !['failed', 'completed'].includes(o.status) || o.failure_reason?.startsWith('paid_'))
    throw new HttpError(409, 'This order cannot be reprinted');
  const f = (await q('SELECT deleted_at FROM order_files WHERE order_id = $1', [o.id])).rows[0];
  if (!f || f.deleted_at) throw new HttpError(410, 'The file was already removed. Ask the customer to upload it again');
  const jobId = await tx(async (c) => {
    await c.query(`UPDATE order_files SET delete_after = NULL WHERE order_id = $1`, [o.id]);
    await c.query(`UPDATE orders SET status = 'paid', failure_reason = NULL WHERE id = $1`, [o.id]);
    const j = await c.query(`UPDATE print_jobs SET status = 'queued', attempts = 0, error = NULL, finished_at = NULL WHERE order_id = $1 RETURNING id`, [o.id]);
    return j.rows[0]?.id;
  });
  if (jobId) await dispatchJob(jobId);
  res.json({ ok: true });
}));

// ---------- Agents ----------
router.get('/agents', wrap(async (req, res) => {
  const r = await q(
    `SELECT a.id, a.name, a.detected_printers, a.last_seen_at, a.token_hash IS NOT NULL AS paired,
            a.pairing_code, a.pairing_expires_at, (SELECT count(*)::int FROM printers p WHERE p.agent_id = a.id) AS printer_count
       FROM agents a WHERE a.shop_id = $1 ORDER BY a.created_at`,
    [req.user.shopId]
  );
  res.json(r.rows.map((a) => ({ ...a, online: isAgentOnline(a.id), pairing_code: a.pairing_expires_at > new Date() ? a.pairing_code : null })));
}));

router.post('/agents', requireOwner, wrap(async (req, res) => {
  const name = String(req.body?.name ?? '').trim().slice(0, 80);
  if (!name) throw new HttpError(400, 'Give this computer a name, e.g. "Counter PC"');
  const r = await q(
    `INSERT INTO agents (shop_id, name, pairing_code, pairing_expires_at) VALUES ($1, $2, $3, now() + interval '15 minutes') RETURNING id, name, pairing_code`,
    [req.user.shopId, name, pairingCode()]
  );
  res.status(201).json(r.rows[0]);
}));

router.post('/agents/:id/pairing', requireOwner, wrap(async (req, res) => {
  const r = await q(
    `UPDATE agents SET pairing_code = $3, pairing_expires_at = now() + interval '15 minutes', token_hash = NULL
      WHERE id = $1 AND shop_id = $2 RETURNING pairing_code`,
    [id(req.params.id), req.user.shopId, pairingCode()]
  );
  if (!r.rows.length) throw new HttpError(404, 'Computer not found');
  res.json(r.rows[0]);
}));

router.delete('/agents/:id', requireOwner, wrap(async (req, res) => {
  const busy = await q(
    `SELECT 1 FROM print_jobs j JOIN printers p ON p.id = j.printer_id WHERE p.agent_id = $1 AND j.status IN ('queued','sent','printing') LIMIT 1`,
    [id(req.params.id)]
  );
  if (busy.rows.length) throw new HttpError(409, 'This computer still has jobs waiting to print');
  await q('DELETE FROM agents WHERE id = $1 AND shop_id = $2', [req.params.id, req.user.shopId]);
  res.json({ ok: true });
}));

// ---------- Printers ----------
function parsePrinter(b) {
  const paper = Array.isArray(b.paperSizes) && b.paperSizes.length ? b.paperSizes : ['A4'];
  if (!paper.every((p) => SIZES.includes(p))) throw new HttpError(400, 'Invalid paper size');
  return {
    displayName: String(b.displayName ?? '').trim().slice(0, 80),
    systemName: String(b.systemName ?? '').trim().slice(0, 200),
    supportsColor: !!b.supportsColor,
    supportsDuplex: !!b.supportsDuplex,
    paper,
  };
}

router.get('/printers', wrap(async (req, res) => {
  const r = await q(
    `SELECT p.*, a.name AS agent_name FROM printers p JOIN agents a ON a.id = p.agent_id WHERE p.shop_id = $1 ORDER BY p.display_name`,
    [req.user.shopId]
  );
  res.json(r.rows.map((p) => ({ ...p, agent_online: isAgentOnline(p.agent_id) })));
}));

router.post('/printers', requireOwner, wrap(async (req, res) => {
  const p = parsePrinter(req.body ?? {});
  if (!p.displayName || !p.systemName) throw new HttpError(400, 'Choose a printer and give it a name');
  const agent = (await q('SELECT id FROM agents WHERE id = $1 AND shop_id = $2', [id(req.body.agentId), req.user.shopId])).rows[0];
  if (!agent) throw new HttpError(404, 'Computer not found');
  const lim = (
    await q(
      `SELECT pl.max_printers, (SELECT count(*)::int FROM printers WHERE shop_id = $1) AS n
         FROM subscriptions sub JOIN plans pl ON pl.id = sub.plan_id WHERE sub.shop_id = $1`,
      [req.user.shopId]
    )
  ).rows[0];
  if (lim && lim.n >= lim.max_printers) throw new HttpError(403, `Your plan allows ${lim.max_printers} printer(s). Upgrade to add more`);
  try {
    const r = await q(
      `INSERT INTO printers (shop_id, agent_id, display_name, system_name, supports_color, supports_duplex, paper_sizes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7::paper_size[], $8) RETURNING id`,
      [req.user.shopId, agent.id, p.displayName, p.systemName, p.supportsColor, p.supportsDuplex, p.paper, isAgentOnline(agent.id) ? 'online' : 'offline']
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'This printer is already added');
    throw e;
  }
}));

router.patch('/printers/:id', requireOwner, wrap(async (req, res) => {
  const b = req.body ?? {};
  const p = parsePrinter({ ...b, systemName: 'x' });
  const r = await q(
    `UPDATE printers SET display_name = COALESCE(NULLIF($3, ''), display_name), supports_color = $4, supports_duplex = $5,
            paper_sizes = $6::paper_size[], is_active = COALESCE($7, is_active),
            status = CASE WHEN $8::boolean THEN 'online'::printer_status ELSE status END
      WHERE id = $1 AND shop_id = $2 RETURNING id`,
    [id(req.params.id), req.user.shopId, p.displayName, p.supportsColor, p.supportsDuplex, p.paper, typeof b.isActive === 'boolean' ? b.isActive : null, b.clearError === true]
  );
  if (!r.rows.length) throw new HttpError(404, 'Printer not found');
  res.json({ ok: true });
}));

router.delete('/printers/:id', requireOwner, wrap(async (req, res) => {
  const busy = await q(`SELECT 1 FROM print_jobs WHERE printer_id = $1 AND status IN ('queued','sent','printing') LIMIT 1`, [id(req.params.id)]);
  if (busy.rows.length) throw new HttpError(409, 'This printer still has jobs waiting. Wait until they finish');
  await q('DELETE FROM printers WHERE id = $1 AND shop_id = $2', [req.params.id, req.user.shopId]);
  res.json({ ok: true });
}));

// ---------- Pricing ----------
router.get('/pricing', wrap(async (req, res) => {
  const r = await q('SELECT color_mode, paper_size, sides, price_per_page FROM pricing_rules WHERE shop_id = $1 ORDER BY paper_size, color_mode, sides', [req.user.shopId]);
  res.json(r.rows);
}));

router.put('/pricing', requireOwner, wrap(async (req, res) => {
  const rules = req.body?.rules;
  if (!Array.isArray(rules) || rules.length > 60) throw new HttpError(400, 'Invalid price list');
  const seen = new Set();
  for (const r of rules) {
    const price = Number(r.pricePerPage);
    if (!['bw', 'color'].includes(r.colorMode) || !SIZES.includes(r.paperSize) || !['single', 'double'].includes(r.sides) || !(price >= 0) || price > 100000)
      throw new HttpError(400, 'Invalid price list');
    const key = `${r.colorMode}|${r.paperSize}|${r.sides}`;
    if (seen.has(key)) throw new HttpError(400, 'Duplicate price rows');
    seen.add(key);
  }
  await tx(async (c) => {
    await c.query('DELETE FROM pricing_rules WHERE shop_id = $1', [req.user.shopId]);
    for (const r of rules) {
      await c.query(`INSERT INTO pricing_rules (shop_id, color_mode, paper_size, sides, price_per_page) VALUES ($1, $2, $3, $4, $5)`, [req.user.shopId, r.colorMode, r.paperSize, r.sides, Number(r.pricePerPage)]);
    }
  });
  res.json({ ok: true });
}));

// ---------- Payment accounts (credentials are encrypted and never sent back) ----------
router.get('/payment-accounts', wrap(async (req, res) => {
  const r = await q('SELECT provider, is_active, credentials_hint, credentials_encrypted IS NOT NULL AS configured FROM shop_payment_accounts WHERE shop_id = $1', [req.user.shopId]);
  const byProvider = Object.fromEntries(r.rows.map((a) => [a.provider, a]));
  res.json(['cash', 'jazzcash', 'easypaisa'].map((p) => ({
    provider: p,
    isActive: !!byProvider[p]?.is_active,
    configured: p === 'cash' ? !!byProvider[p] : !!byProvider[p]?.configured,
    hint: byProvider[p]?.credentials_hint ?? null,
    requiredFields: requiredFields(p),
  })));
}));

router.put('/payment-accounts/:provider', requireOwner, wrap(async (req, res) => {
  const provider = req.params.provider;
  if (!['cash', 'jazzcash', 'easypaisa'].includes(provider)) throw new HttpError(404, 'Unknown payment method');
  const isActive = req.body?.isActive !== false;

  if (provider === 'cash') {
    await q(`INSERT INTO shop_payment_accounts (shop_id, provider, is_active) VALUES ($1, 'cash', $2) ON CONFLICT (shop_id, provider) DO UPDATE SET is_active = $2`, [req.user.shopId, isActive]);
    return res.json({ ok: true });
  }

  const creds = req.body?.credentials;
  if (creds) {
    for (const f of requiredFields(provider)) {
      if (!creds[f] || String(creds[f]).trim() === '') throw new HttpError(400, `Missing field: ${f}`);
    }
    const clean = Object.fromEntries(Object.entries(creds).map(([k, v]) => [k, k === 'sandbox' ? v === true : String(v).trim()]));
    const hintSource = clean.merchantId || clean.storeId || '';
    await q(
      `INSERT INTO shop_payment_accounts (shop_id, provider, credentials_encrypted, credentials_hint, is_active)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (shop_id, provider) DO UPDATE SET credentials_encrypted = $3, credentials_hint = $4, is_active = $5`,
      [req.user.shopId, provider, encrypt(clean), hintSource ? `…${hintSource.slice(-4)}` : null, isActive]
    );
  } else {
    const r = await q('UPDATE shop_payment_accounts SET is_active = $3 WHERE shop_id = $1 AND provider = $2 AND credentials_encrypted IS NOT NULL RETURNING id', [req.user.shopId, provider, isActive]);
    if (!r.rows.length) throw new HttpError(400, 'Enter your merchant details first');
  }
  res.json({ ok: true });
}));

router.delete('/payment-accounts/:provider', requireOwner, wrap(async (req, res) => {
  if (req.params.provider === 'cash') throw new HttpError(400, 'Turn cash off instead of removing it');
  await q(`DELETE FROM shop_payment_accounts WHERE shop_id = $1 AND provider = $2`, [req.user.shopId, req.params.provider]);
  res.json({ ok: true });
}));

// ---------- Staff ----------
router.get('/users', requireOwner, wrap(async (req, res) => {
  const r = await q('SELECT id, email, role, created_at FROM shop_users WHERE shop_id = $1 ORDER BY created_at', [req.user.shopId]);
  res.json(r.rows);
}));

router.post('/users', requireOwner, wrap(async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address');
  if (String(req.body?.password ?? '').length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  try {
    const r = await q(`INSERT INTO shop_users (shop_id, email, password_hash, role) VALUES ($1, $2, $3, 'staff') RETURNING id`, [req.user.shopId, email, await hashPassword(String(req.body.password))]);
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'An account with this email already exists');
    throw e;
  }
}));

router.delete('/users/:id', requireOwner, wrap(async (req, res) => {
  if (id(req.params.id) === req.user.id) throw new HttpError(400, 'You cannot remove your own account');
  await q(`DELETE FROM shop_users WHERE id = $1 AND shop_id = $2 AND role = 'staff'`, [req.params.id, req.user.shopId]);
  res.json({ ok: true });
}));

export default router;
