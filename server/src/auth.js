import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { q } from './db.js';
import { HttpError, wrap } from './errors.js';

export const hashPassword = (pw) => bcrypt.hash(pw, 10);
export const checkPassword = (pw, hash) => bcrypt.compare(pw, hash);

export const signShopToken = (u) =>
  jwt.sign({ sub: u.id, shop: u.shop_id, role: u.role, t: 'shop' }, config.jwtSecret, { expiresIn: '12h' });
export const signAdminToken = (a) => jwt.sign({ sub: a.id, t: 'admin' }, config.jwtSecret, { expiresIn: '8h' });

function readToken(req, type) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) throw new HttpError(401, 'Please sign in');
  try {
    const p = jwt.verify(h.slice(7), config.jwtSecret);
    if (p.t !== type) throw new Error('wrong token type');
    return p;
  } catch {
    throw new HttpError(401, 'Your session has expired. Please sign in again');
  }
}

export const requireShop = wrap(async (req, _res, next) => {
  const p = readToken(req, 'shop');
  const r = await q(
    `SELECT u.id, u.shop_id, u.role, s.status AS shop_status
       FROM shop_users u JOIN shops s ON s.id = u.shop_id WHERE u.id = $1`,
    [p.sub]
  );
  const u = r.rows[0];
  if (!u) throw new HttpError(401, 'Account not found');
  if (u.shop_status === 'suspended') throw new HttpError(403, 'This shop is suspended. Contact support');
  req.user = { id: u.id, shopId: u.shop_id, role: u.role, shopStatus: u.shop_status };
  next();
});

export const requireOwner = (req, _res, next) =>
  req.user.role === 'owner' ? next() : next(new HttpError(403, 'Only the shop owner can do this'));

export const requireAdmin = wrap(async (req, _res, next) => {
  const p = readToken(req, 'admin');
  const r = await q('SELECT id, email FROM platform_admins WHERE id = $1', [p.sub]);
  if (!r.rows.length) throw new HttpError(401, 'Account not found');
  req.admin = { id: r.rows[0].id, email: r.rows[0].email };
  next();
});
