// Platform admin API (super admin only): shops, free trials, subscriptions, plans, settings, activity log.
import { Router } from 'express';
import { q, tx } from '../db.js';
import { HttpError, wrap } from '../errors.js';
import { requireAdmin, hashPassword } from '../auth.js';
import { randomToken } from '../crypto.js';
import { isAgentOnline } from '../hub.js';
import { getSettings, validateSettings, saveSettings } from '../settings.js';
import { removeShopFiles } from '../storage.js';

const router = Router();
router.use(requireAdmin);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uid = (v) => {
  if (!UUID_RE.test(String(v))) throw new HttpError(404, 'Not found');
  return v;
};

const audit = (req, action, shop, details = null, db = { query: q }) =>
  db.query(
    `INSERT INTO admin_audit (admin_id, admin_email, action, shop_id, shop_name, details) VALUES ($1, $2, $3, $4, $5, $6)`,
    [req.admin.id, req.admin.email, action, shop?.id ?? null, shop?.name ?? null, details ? JSON.stringify(details) : null]
  );

// What the admin sees about a shop's money situation:
//   suspended / pending (set by the admin) > expired (trial or paid period ran out) > trial > paid > past_due > cancelled
const STATE_SQL = `CASE
  WHEN s.status = 'suspended' THEN 'suspended'
  WHEN s.status = 'pending' THEN 'pending'
  WHEN sub.status IN ('trialing', 'active') AND sub.current_period_end < now() THEN 'expired'
  WHEN sub.status = 'trialing' THEN 'trial'
  WHEN sub.status = 'active' THEN 'paid'
  WHEN sub.status = 'past_due' THEN 'past_due'
  WHEN sub.status = 'cancelled' THEN 'cancelled'
  ELSE 'none' END`;

const SHOP_COLUMNS = `
  s.id, s.name, s.slug, s.city, s.phone, s.status, s.created_at, s.admin_note,
  sub.status AS sub_status, sub.current_period_end, sub.plan_id, pl.name AS plan_name,
  ${STATE_SQL} AS state,
  CEIL(EXTRACT(EPOCH FROM (sub.current_period_end - now())) / 86400)::int AS days_left,
  (SELECT email FROM shop_users u WHERE u.shop_id = s.id AND u.role = 'owner' ORDER BY u.created_at LIMIT 1) AS owner_email,
  (SELECT count(*)::int FROM orders o WHERE o.shop_id = s.id AND o.status <> 'draft') AS orders,
  (SELECT max(o.created_at) FROM orders o WHERE o.shop_id = s.id AND o.status <> 'draft') AS last_order_at,
  COALESCE((SELECT sum(o.amount) FROM orders o WHERE o.shop_id = s.id AND o.payment_status = 'paid'), 0) AS revenue,
  (SELECT count(*)::int FROM printers p WHERE p.shop_id = s.id) AS printers,
  COALESCE((SELECT array_agg(a.id::text) FROM agents a WHERE a.shop_id = s.id AND a.token_hash IS NOT NULL), '{}') AS agent_ids`;
const SHOP_FROM = `FROM shops s LEFT JOIN subscriptions sub ON sub.shop_id = s.id LEFT JOIN plans pl ON pl.id = sub.plan_id`;

function decorate(row) {
  const { agent_ids: ids, ...rest } = row;
  return { ...rest, agents_online: ids.filter((id) => isAgentOnline(id)).length };
}

const listShops = async () => (await q(`SELECT ${SHOP_COLUMNS} ${SHOP_FROM} ORDER BY s.created_at DESC`)).rows.map(decorate);

async function getShop(id) {
  const r = await q(`SELECT ${SHOP_COLUMNS} ${SHOP_FROM} WHERE s.id = $1`, [uid(id)]);
  if (!r.rows.length) throw new HttpError(404, 'Shop not found');
  return decorate(r.rows[0]);
}

// ---------------------------------------------------------------- overview
router.get('/stats', wrap(async (_req, res) => {
  const r = await q(
    `SELECT (SELECT count(*)::int FROM shops) AS shops,
            (SELECT count(*)::int FROM shops WHERE status = 'pending') AS pending_shops,
            (SELECT count(*)::int FROM orders WHERE created_at > now() - interval '30 days' AND status <> 'draft') AS orders_30d,
            (SELECT COALESCE(sum(amount), 0) FROM orders WHERE payment_status = 'paid' AND paid_at > now() - interval '30 days') AS gross_30d`
  );
  res.json(r.rows[0]);
}));

router.get('/overview', wrap(async (_req, res) => {
  const shops = await listShops();
  const counts = {};
  for (const s of shops) counts[s.state] = (counts[s.state] ?? 0) + 1;
  const money = (await q(
    `SELECT (SELECT count(*)::int FROM orders WHERE created_at > now() - interval '30 days' AND status <> 'draft') AS orders_30d,
            (SELECT COALESCE(sum(amount), 0) FROM orders WHERE payment_status = 'paid' AND paid_at > now() - interval '30 days') AS gross_30d,
            (SELECT count(*)::int FROM shops WHERE created_at > now() - interval '7 days') AS new_shops_7d`
  )).rows[0];
  const brief = (s) => ({ id: s.id, name: s.name, slug: s.slug, owner_email: s.owner_email, state: s.state, days_left: s.days_left, created_at: s.created_at });
  res.json({
    total: shops.length,
    counts,
    ...money,
    attention: {
      pending: shops.filter((s) => s.state === 'pending').map(brief),
      endingSoon: shops.filter((s) => s.state === 'trial' && s.days_left <= 7).sort((a, b) => a.days_left - b.days_left).map(brief),
      expired: shops.filter((s) => s.state === 'expired').sort((a, b) => b.days_left - a.days_left).map(brief),
    },
  });
}));

// ---------------------------------------------------------------- shops
router.get('/shops', wrap(async (_req, res) => {
  res.json(await listShops());
}));

router.get('/shops/:id', wrap(async (req, res) => {
  const shop = await getShop(req.params.id);
  const [users, orders, agents, printers, activity] = await Promise.all([
    q('SELECT id, email, role, created_at FROM shop_users WHERE shop_id = $1 ORDER BY created_at', [shop.id]),
    q(`SELECT id, public_code, status, payment_status, payment_method, amount, created_at FROM orders
        WHERE shop_id = $1 AND status <> 'draft' ORDER BY created_at DESC LIMIT 10`, [shop.id]),
    q('SELECT id, name, last_seen_at, token_hash IS NOT NULL AS paired FROM agents WHERE shop_id = $1 ORDER BY created_at', [shop.id]),
    q('SELECT display_name, status, supports_color, supports_duplex, is_active FROM printers WHERE shop_id = $1 ORDER BY display_name', [shop.id]),
    q('SELECT admin_email, action, details, created_at FROM admin_audit WHERE shop_id = $1 ORDER BY created_at DESC LIMIT 20', [shop.id]),
  ]);
  res.json({
    shop, users: users.rows, orders: orders.rows, printers: printers.rows, activity: activity.rows,
    agents: agents.rows.map((a) => ({ ...a, online: isAgentOnline(a.id) })),
  });
}));

router.patch('/shops/:id', wrap(async (req, res) => {
  const shop = await getShop(req.params.id);
  const { status, adminNote } = req.body ?? {};
  if (status === undefined && adminNote === undefined) throw new HttpError(400, 'Nothing to change');
  if (status !== undefined) {
    if (!['pending', 'active', 'suspended'].includes(status)) throw new HttpError(400, 'Invalid status');
    if (status !== shop.status) {
      await q('UPDATE shops SET status = $2 WHERE id = $1', [shop.id, status]);
      await audit(req, 'shop.status', shop, { from: shop.status, to: status });
    }
  }
  if (adminNote !== undefined) {
    await q('UPDATE shops SET admin_note = $2 WHERE id = $1', [shop.id, String(adminNote).slice(0, 2000) || null]);
    await audit(req, 'shop.note', shop);
  }
  res.json({ ok: true });
}));

router.put('/shops/:id/subscription', wrap(async (req, res) => {
  const shop = await getShop(req.params.id);
  const { planId, status, periodEnd } = req.body ?? {};
  if (!['trialing', 'active', 'past_due', 'cancelled'].includes(status)) throw new HttpError(400, 'Invalid subscription status');
  const end = new Date(periodEnd);
  if (Number.isNaN(end.getTime())) throw new HttpError(400, 'Invalid end date');
  const r = await q(
    `UPDATE subscriptions SET plan_id = $2, status = $3, current_period_end = $4 WHERE shop_id = $1 RETURNING id`,
    [shop.id, uid(planId), status, end.toISOString()]
  );
  if (!r.rows.length) throw new HttpError(404, 'Shop not found');
  await audit(req, 'subscription.set', shop, { planId, status, periodEnd: end.toISOString() });
  res.json({ ok: true });
}));

// Add days to the current end date (from today if it already ran out). markPaid also sets the status to active.
router.post('/shops/:id/extend', wrap(async (req, res) => {
  const shop = await getShop(req.params.id);
  const days = Number(req.body?.days);
  if (!Number.isInteger(days) || days < 1 || days > 1095) throw new HttpError(400, 'Days must be between 1 and 1095');
  const markPaid = req.body?.markPaid === true;
  const r = await q(
    `UPDATE subscriptions
        SET current_period_end = GREATEST(now(), current_period_end) + make_interval(days => $2),
            status = CASE WHEN $3::boolean THEN 'active'::sub_status
                          WHEN status IN ('past_due', 'cancelled') THEN 'trialing'::sub_status ELSE status END
      WHERE shop_id = $1 RETURNING status, current_period_end`,
    [shop.id, days, markPaid]
  );
  if (!r.rows.length) throw new HttpError(404, 'Shop has no subscription');
  await audit(req, markPaid ? 'subscription.paid' : 'subscription.extend', shop, { days, until: r.rows[0].current_period_end });
  res.json(r.rows[0]);
}));

// Gives the shop owner a new random password, shown once to the admin (never stored in clear text).
router.post('/shops/:id/reset-password', wrap(async (req, res) => {
  const shop = await getShop(req.params.id);
  const password = randomToken(5);
  const r = await q(
    `UPDATE shop_users SET password_hash = $2 WHERE shop_id = $1 AND role = 'owner' RETURNING email`,
    [shop.id, await hashPassword(password)]
  );
  if (!r.rows.length) throw new HttpError(404, 'This shop has no owner account');
  await audit(req, 'owner.password_reset', shop, { email: r.rows[0].email });
  res.json({ email: r.rows[0].email, password });
}));

router.delete('/shops/:id', wrap(async (req, res) => {
  const shop = await getShop(req.params.id);
  if (String(req.body?.confirmSlug ?? '') !== shop.slug) throw new HttpError(400, 'Type the shop link exactly to confirm');
  await audit(req, 'shop.delete', shop, { slug: shop.slug, orders: shop.orders });
  await q('DELETE FROM shops WHERE id = $1', [shop.id]);
  await removeShopFiles(shop.id);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- plans
router.get('/plans', wrap(async (_req, res) => {
  res.json((await q(`SELECT p.*, (SELECT count(*)::int FROM subscriptions s WHERE s.plan_id = p.id) AS shops FROM plans p ORDER BY price_monthly`)).rows);
}));

function planFields(b) {
  const name = String(b.name ?? '').trim();
  if (!name) throw new HttpError(400, 'Enter a plan name');
  const price = Number(b.priceMonthly);
  const printers = Number(b.maxPrinters);
  if (!(price >= 0) || !Number.isInteger(printers) || printers < 1) throw new HttpError(400, 'Enter a price and a printer limit (at least 1)');
  const orders = b.maxOrdersPerMonth === '' || b.maxOrdersPerMonth == null ? null : Number(b.maxOrdersPerMonth);
  if (orders !== null && (!Number.isInteger(orders) || orders < 1)) throw new HttpError(400, 'Orders per month must be a whole number, or empty for unlimited');
  return { name, price, printers, orders };
}

router.post('/plans', wrap(async (req, res) => {
  const f = planFields(req.body ?? {});
  try {
    const r = await q(`INSERT INTO plans (name, price_monthly, max_printers, max_orders_per_month) VALUES ($1, $2, $3, $4) RETURNING *`, [f.name, f.price, f.printers, f.orders]);
    await audit(req, 'plan.add', null, { name: f.name });
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'A plan with this name already exists');
    throw e;
  }
}));

router.put('/plans/:id', wrap(async (req, res) => {
  const b = req.body ?? {};
  const id = uid(req.params.id);
  const before = (await q('SELECT * FROM plans WHERE id = $1', [id])).rows[0];
  if (!before) throw new HttpError(404, 'Plan not found');
  // a plain on/off switch only sends isActive; a full edit sends all the fields
  const f = 'name' in b ? planFields(b) : { name: before.name, price: before.price_monthly, printers: before.max_printers, orders: before.max_orders_per_month };
  const active = typeof b.isActive === 'boolean' ? b.isActive : before.is_active;
  try {
    await q(`UPDATE plans SET name = $2, price_monthly = $3, max_printers = $4, max_orders_per_month = $5, is_active = $6 WHERE id = $1`, [id, f.name, f.price, f.printers, f.orders, active]);
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'A plan with this name already exists');
    throw e;
  }
  await audit(req, 'plan.edit', null, { name: f.name, active });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- settings & activity
router.get('/settings', wrap(async (_req, res) => {
  res.json(await getSettings());
}));

router.put('/settings', wrap(async (req, res) => {
  const values = await validateSettings(req.body ?? {});
  if (!Object.keys(values).length) throw new HttpError(400, 'Nothing to change');
  await tx(async (c) => {
    await saveSettings(c, values);
    await audit(req, 'settings.change', null, values, c);
  });
  res.json(await getSettings());
}));

router.get('/audit', wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json((await q('SELECT id, admin_email, action, shop_id, shop_name, details, created_at FROM admin_audit ORDER BY created_at DESC, id DESC LIMIT $1', [limit])).rows);
}));

export default router;
