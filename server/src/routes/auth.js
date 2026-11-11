import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { q, tx } from '../db.js';
import { HttpError, wrap } from '../errors.js';
import { hashPassword, checkPassword, signShopToken, signAdminToken } from '../auth.js';
import { getSettings } from '../settings.js';

const router = Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false });
router.use(limiter);

const RESERVED = new Set(['admin', 'api', 'assets', 's', 'o', 'pay', 'login', 'dashboard', 'qr', 'ws', 'healthz', 'www', 'app']);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DEFAULT_PRICES = [
  ['bw', 'single', 15],
  ['bw', 'double', 12],
  ['color', 'single', 50],
  ['color', 'double', 45],
];

router.post('/signup', wrap(async (req, res) => {
  const settings = await getSettings();
  if (!settings.signupsEnabled) throw new HttpError(403, 'New shop sign-ups are closed right now');
  const { shopName, slug, email, password, phone, city } = req.body ?? {};
  const cleanSlug = String(slug ?? '').trim().toLowerCase();
  const cleanEmail = String(email ?? '').trim().toLowerCase();
  if (!shopName || String(shopName).trim().length < 2) throw new HttpError(400, 'Enter your shop name');
  if (!SLUG_RE.test(cleanSlug) || RESERVED.has(cleanSlug))
    throw new HttpError(400, 'Shop link must be 3-40 characters: letters, numbers and dashes only');
  if (!EMAIL_RE.test(cleanEmail)) throw new HttpError(400, 'Enter a valid email address');
  if (String(password ?? '').length < 8) throw new HttpError(400, 'Password must be at least 8 characters');

  try {
    const result = await tx(async (c) => {
      const shop = (
        await c.query(
          `INSERT INTO shops (name, slug, phone, city, status) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, slug, status`,
          [String(shopName).trim().slice(0, 120), cleanSlug, phone ? String(phone).slice(0, 30) : null, city ? String(city).slice(0, 80) : null, settings.requireApproval ? 'pending' : 'active']
        )
      ).rows[0];
      const user = (
        await c.query(
          `INSERT INTO shop_users (shop_id, email, password_hash, role) VALUES ($1, $2, $3, 'owner') RETURNING id, shop_id, role`,
          [shop.id, cleanEmail, await hashPassword(String(password))]
        )
      ).rows[0];
      const plan = (await c.query(
        `SELECT id FROM plans WHERE is_active ORDER BY (id = $1::uuid) DESC, price_monthly LIMIT 1`, [settings.defaultPlanId])).rows[0];
      await c.query(
        `INSERT INTO subscriptions (shop_id, plan_id, status, current_period_end)
         VALUES ($1, $2, 'trialing', now() + make_interval(days => $3))`,
        [shop.id, plan.id, settings.defaultTrialDays]
      );
      for (const [color, sides, price] of DEFAULT_PRICES) {
        await c.query(`INSERT INTO pricing_rules (shop_id, color_mode, paper_size, sides, price_per_page) VALUES ($1, $2, 'A4', $3, $4)`, [shop.id, color, sides, price]);
      }
      await c.query(`INSERT INTO shop_payment_accounts (shop_id, provider, is_active) VALUES ($1, 'cash', true)`, [shop.id]);
      return { shop, user };
    });
    res.status(201).json({ token: signShopToken(result.user), shop: result.shop });
  } catch (e) {
    if (e.code === '23505') {
      if (String(e.constraint).includes('slug')) throw new HttpError(409, 'This shop link is already taken');
      throw new HttpError(409, 'An account with this email already exists');
    }
    throw e;
  }
}));

router.post('/login', wrap(async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const r = await q('SELECT id, shop_id, role, password_hash FROM shop_users WHERE email = $1', [email]);
  const u = r.rows[0];
  // Same message for unknown email and wrong password.
  if (!u || !(await checkPassword(String(req.body?.password ?? ''), u.password_hash)))
    throw new HttpError(401, 'Email or password is incorrect');
  res.json({ token: signShopToken(u) });
}));

router.post('/admin/login', wrap(async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const r = await q('SELECT id, password_hash FROM platform_admins WHERE email = $1', [email]);
  const a = r.rows[0];
  if (!a || !(await checkPassword(String(req.body?.password ?? ''), a.password_hash)))
    throw new HttpError(401, 'Email or password is incorrect');
  res.json({ token: signAdminToken(a) });
}));

export default router;
