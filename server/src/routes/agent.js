import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs';
import { q } from '../db.js';
import { HttpError, wrap } from '../errors.js';
import { randomToken, sha256 } from '../crypto.js';
import { authenticateAgent, isAgentOnline } from '../hub.js';

const router = Router();
const pairLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

router.post('/pair', pairLimiter, wrap(async (req, res) => {
  const code = String(req.body?.code ?? '').trim().toUpperCase();
  if (!code) throw new HttpError(400, 'Enter the pairing code from your dashboard');
  const token = randomToken(32);
  const r = await q(
    `UPDATE agents SET token_hash = $2, pairing_code = NULL, pairing_expires_at = NULL
      WHERE pairing_code = $1 AND pairing_expires_at > now()
      RETURNING id, name, shop_id`,
    [code, sha256(token)]
  );
  if (!r.rows.length) throw new HttpError(400, 'This code is wrong or has expired. Create a new one in the dashboard');
  const shop = (await q('SELECT name FROM shops WHERE id = $1', [r.rows[0].shop_id])).rows[0];
  res.json({ token, agentId: r.rows[0].id, shopName: shop.name });
}));

// The agent downloads the PDF for a job it was sent over the WebSocket.
router.get('/jobs/:id/file', wrap(async (req, res) => {
  const agent = await authenticateAgent((req.headers.authorization || '').replace(/^Bearer /, ''));
  if (!agent) throw new HttpError(401, 'Invalid agent token');
  const r = await q(
    `SELECT f.storage_path, f.deleted_at
       FROM print_jobs j
       JOIN printers p ON p.id = j.printer_id
       JOIN order_files f ON f.order_id = j.order_id
      WHERE j.id = $1 AND p.agent_id = $2`,
    [req.params.id.match(/^[0-9a-f-]{36}$/i) ? req.params.id : '00000000-0000-0000-0000-000000000000', agent.id]
  );
  const f = r.rows[0];
  if (!f || f.deleted_at || !fs.existsSync(f.storage_path)) throw new HttpError(404, 'File not available');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(f.storage_path).pipe(res);
}));

const SIZES = ['A4', 'A3', 'A5', 'Legal', 'Letter'];

// One click from the agent app: add every printer on the shop computer to the shop.
// Existing printers are left untouched (the owner may have edited them). The plan's printer limit applies.
router.post('/printers/sync', pairLimiter, wrap(async (req, res) => {
  const agent = await authenticateAgent((req.headers.authorization || '').replace(/^Bearer /, ''));
  if (!agent) throw new HttpError(401, 'Invalid agent token');
  const input = Array.isArray(req.body?.printers) ? req.body.printers.slice(0, 50) : [];
  const list = [];
  for (const p of input) {
    const name = String(p?.name ?? '').trim().slice(0, 200);
    if (!name || list.some((x) => x.name === name)) continue;
    const sizes = (Array.isArray(p.paperSizes) ? p.paperSizes : []).filter((z) => SIZES.includes(z));
    list.push({ name, color: p.color === true, duplex: p.duplex === true, sizes: sizes.length ? sizes : ['A4'] });
  }

  const added = []; const existing = []; const skipped = [];
  const lim = (await q(
    `SELECT pl.max_printers, (SELECT count(*)::int FROM printers WHERE shop_id = $1) AS n
       FROM subscriptions sub JOIN plans pl ON pl.id = sub.plan_id WHERE sub.shop_id = $1`, [agent.shop_id])).rows[0];
  let count = lim?.n ?? 0;
  const max = lim?.max_printers ?? Infinity;

  for (const p of list) {
    const dupe = await q('SELECT 1 FROM printers WHERE agent_id = $1 AND system_name = $2', [agent.id, p.name]);
    if (dupe.rows.length) { existing.push(p.name); continue; }
    if (count >= max) { skipped.push(p.name); continue; }
    await q(
      `INSERT INTO printers (shop_id, agent_id, display_name, system_name, supports_color, supports_duplex, paper_sizes, status)
       VALUES ($1, $2, $3, $3, $4, $5, $6::paper_size[], $7)`,
      [agent.shop_id, agent.id, p.name, p.color, p.duplex, p.sizes, isAgentOnline(agent.id) ? 'online' : 'offline']
    );
    count++;
    added.push(p.name);
  }
  res.json({ added, existing, skipped, limit: Number.isFinite(max) ? max : null });
}));

export default router;
