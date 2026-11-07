import { Router } from 'express';
import { q } from '../db.js';
import { HttpError, wrap } from '../errors.js';
import { requireAdmin } from '../auth.js';

const router = Router();
router.use(requireAdmin);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uid = (v) => {
  if (!UUID_RE.test(String(v))) throw new HttpError(404, 'Not found');
  return v;
};

router.get('/stats', wrap(async (_req, res) => {
  const r = await q(
    `SELECT (SELECT count(*)::int FROM shops) AS shops,
            (SELECT count(*)::int FROM shops WHERE status = 'pending') AS pending_shops,
            (SELECT count(*)::int FROM orders WHERE created_at > now() - interval '30 days' AND status <> 'draft') AS orders_30d,
            (SELECT COALESCE(sum(amount), 0) FROM orders WHERE payment_status = 'paid' AND paid_at > now() - interval '30 days') AS gross_30d`
  );
  res.json(r.rows[0]);
}));

router.get('/shops', wrap(async (_req, res) => {
  const r = await q(
    `SELECT s.id, s.name, s.slug, s.city, s.phone, s.status, s.created_at,
            sub.status AS sub_status, sub.current_period_end, sub.plan_id, pl.name AS plan_name,
            (SELECT count(*)::int FROM orders o WHERE o.shop_id = s.id AND o.status <> 'draft') AS orders,
            (SELECT email FROM shop_users u WHERE u.shop_id = s.id AND u.role = 'owner' LIMIT 1) AS owner_email
       FROM shops s LEFT JOIN subscriptions sub ON sub.shop_id = s.id LEFT JOIN plans pl ON pl.id = sub.plan_id
      ORDER BY s.created_at DESC`
  );
  res.json(r.rows);
}));

router.patch('/shops/:id', wrap(async (req, res) => {
  const status = req.body?.status;
  if (!['pending', 'active', 'suspended'].includes(status)) throw new HttpError(400, 'Invalid status');
  await q('UPDATE shops SET status = $2 WHERE id = $1', [uid(req.params.id), status]);
  res.json({ ok: true });
}));

router.put('/shops/:id/subscription', wrap(async (req, res) => {
  const { planId, status, periodEnd } = req.body ?? {};
  if (!['trialing', 'active', 'past_due', 'cancelled'].includes(status)) throw new HttpError(400, 'Invalid subscription status');
  const end = new Date(periodEnd);
  if (Number.isNaN(end.getTime())) throw new HttpError(400, 'Invalid end date');
  const r = await q(
    `UPDATE subscriptions SET plan_id = $2, status = $3, current_period_end = $4 WHERE shop_id = $1 RETURNING id`,
    [uid(req.params.id), uid(planId), status, end.toISOString()]
  );
  if (!r.rows.length) throw new HttpError(404, 'Shop not found');
  res.json({ ok: true });
}));

router.get('/plans', wrap(async (_req, res) => {
  res.json((await q('SELECT * FROM plans ORDER BY price_monthly')).rows);
}));

router.post('/plans', wrap(async (req, res) => {
  const { name, priceMonthly, maxPrinters, maxOrdersPerMonth } = req.body ?? {};
  if (!name || !(Number(priceMonthly) >= 0) || !(Number(maxPrinters) >= 1)) throw new HttpError(400, 'Fill in name, price and printer limit');
  try {
    const r = await q(`INSERT INTO plans (name, price_monthly, max_printers, max_orders_per_month) VALUES ($1, $2, $3, $4) RETURNING *`, [String(name).trim(), Number(priceMonthly), Number(maxPrinters), maxOrdersPerMonth ? Number(maxOrdersPerMonth) : null]);
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'A plan with this name already exists');
    throw e;
  }
}));

router.put('/plans/:id', wrap(async (req, res) => {
  const { name, priceMonthly, maxPrinters, maxOrdersPerMonth, isActive } = req.body ?? {};
  await q(
    `UPDATE plans SET name = COALESCE($2, name), price_monthly = COALESCE($3, price_monthly), max_printers = COALESCE($4, max_printers),
            max_orders_per_month = $5, is_active = COALESCE($6, is_active) WHERE id = $1`,
    [uid(req.params.id), name ?? null, priceMonthly != null ? Number(priceMonthly) : null, maxPrinters != null ? Number(maxPrinters) : null, maxOrdersPerMonth ? Number(maxOrdersPerMonth) : null, typeof isActive === 'boolean' ? isActive : null]
  );
  res.json({ ok: true });
}));

export default router;
