// Customer-facing API (no login). An order is accessed through its unguessable UUID.
import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { q, tx } from '../db.js';
import { HttpError, wrap } from '../errors.js';
import { config } from '../config.js';
import { orderCode } from '../crypto.js';
import { decrypt } from '../crypto.js';
import { normalizeUpload } from '../files.js';
import { orderFilePath, saveFile } from '../storage.js';
import { priceOrder } from '../pricing.js';
import { isAgentOnline } from '../hub.js';
import { createPayment } from '../payments.js';
import { providers, availableProviders } from '../providers/index.js';

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLORS = ['bw', 'color'];
const SIZES = ['A4', 'A3', 'A5', 'Legal', 'Letter'];
const SIDES = ['single', 'double'];

const createLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxFileMb * 1024 * 1024, files: 1 } });

async function loadShop(slug) {
  const r = await q(
    `SELECT s.*, sub.status AS sub_status, sub.current_period_end, pl.max_orders_per_month
       FROM shops s
       LEFT JOIN subscriptions sub ON sub.shop_id = s.id
       LEFT JOIN plans pl ON pl.id = sub.plan_id
      WHERE s.slug = $1`,
    [String(slug).toLowerCase()]
  );
  if (!r.rows.length) throw new HttpError(404, 'Shop not found');
  return r.rows[0];
}

function closedReason(s) {
  if (s.status === 'pending') return 'This shop is waiting for approval';
  if (s.status !== 'active') return 'This shop is not accepting orders right now';
  if (!['trialing', 'active'].includes(s.sub_status) || new Date(s.current_period_end) < new Date())
    return 'This shop is not accepting orders right now';
  return null;
}

async function loadOrder(id) {
  if (!UUID_RE.test(String(id))) throw new HttpError(404, 'Order not found');
  const r = await q('SELECT * FROM orders WHERE id = $1', [id]);
  if (!r.rows.length) throw new HttpError(404, 'Order not found');
  return r.rows[0];
}

const editable = (o) => ['draft', 'awaiting_payment'].includes(o.status) && o.payment_status !== 'paid';

// Older unpaid gateway attempts must not be able to complete after the order changed.
const invalidatePending = (db, orderId) =>
  db.query(`UPDATE payments SET status = 'failed' WHERE order_id = $1 AND status = 'pending'`, [orderId]);

router.get('/shops/:slug', wrap(async (req, res) => {
  const s = await loadShop(req.params.slug);
  const [pricing, printers, accounts] = await Promise.all([
    q('SELECT color_mode, paper_size, sides, price_per_page FROM pricing_rules WHERE shop_id = $1', [s.id]),
    q('SELECT id, agent_id, supports_color, supports_duplex, paper_sizes FROM printers WHERE shop_id = $1 AND is_active', [s.id]),
    q('SELECT provider FROM shop_payment_accounts WHERE shop_id = $1 AND is_active', [s.id]),
  ]);
  const online = printers.rows.filter((p) => isAgentOnline(p.agent_id));
  const methods = new Set(accounts.rows.map((a) => a.provider).filter((p) => p === 'cash' || p === 'easypaisa' || p === 'jazzcash'));
  if (config.enableMockPayments) methods.add('mock');
  res.json({
    name: s.name,
    city: s.city,
    phone: s.phone,
    closedReason: closedReason(s),
    printersOnline: online.length,
    colorAvailable: online.some((p) => p.supports_color),
    duplexAvailable: online.some((p) => p.supports_duplex),
    paperSizes: [...new Set(online.flatMap((p) => p.paper_sizes))],
    pricing: pricing.rows,
    paymentMethods: [...methods],
    maxFileMb: config.maxFileMb,
  });
}));

router.post('/shops/:slug/orders', createLimiter, wrap(async (req, res) => {
  const s = await loadShop(req.params.slug);
  const reason = closedReason(s);
  if (reason) throw new HttpError(403, reason);
  if (s.max_orders_per_month != null) {
    const n = await q(`SELECT count(*)::int AS n FROM orders WHERE shop_id = $1 AND created_at >= date_trunc('month', now())`, [s.id]);
    if (n.rows[0].n >= s.max_orders_per_month) throw new HttpError(403, 'This shop has reached its monthly order limit');
  }
  const phone = req.body?.phone ? String(req.body.phone).replace(/[^\d+]/g, '').slice(0, 20) : null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await q(`INSERT INTO orders (shop_id, public_code, customer_phone) VALUES ($1, $2, $3) RETURNING id, public_code`, [s.id, orderCode(), phone]);
      return res.status(201).json({ orderId: r.rows[0].id, code: r.rows[0].public_code });
    } catch (e) {
      if (e.code !== '23505') throw e;
    }
  }
  throw new HttpError(503, 'Please try again');
}));

router.post('/orders/:id/file', createLimiter, upload.single('file'), wrap(async (req, res) => {
  const order = await loadOrder(req.params.id);
  if (!editable(order)) throw new HttpError(409, 'This order can no longer be changed');
  if (!req.file) throw new HttpError(400, 'Choose a file to upload');

  const { pdf, pageCount } = await normalizeUpload(req.file.buffer, req.file.originalname);
  const filePath = orderFilePath(order.shop_id, order.id);
  await saveFile(filePath, pdf);
  const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8').slice(0, 200);

  await tx(async (c) => {
    await c.query(
      `INSERT INTO order_files (order_id, shop_id, storage_path, original_name, mime_type, size_bytes, page_count)
       VALUES ($1, $2, $3, $4, 'application/pdf', $5, $6)
       ON CONFLICT (order_id) DO UPDATE SET storage_path = EXCLUDED.storage_path, original_name = EXCLUDED.original_name,
         size_bytes = EXCLUDED.size_bytes, page_count = EXCLUDED.page_count, deleted_at = NULL, delete_after = NULL`,
      [order.id, order.shop_id, filePath, name, pdf.length, pageCount]
    );
    await c.query(
      `UPDATE orders SET total_pages = $2, page_from = NULL, page_to = NULL, amount = NULL, printer_id = NULL,
              status = 'draft', expires_at = now() + interval '30 minutes' WHERE id = $1`,
      [order.id, pageCount]
    );
    await invalidatePending(c, order.id);
  });
  res.json({ fileName: name, pages: pageCount });
}));

async function pickPrinter(shopId, o) {
  const r = await q(
    `SELECT p.id, p.agent_id,
            (SELECT count(*) FROM print_jobs j WHERE j.printer_id = p.id AND j.status IN ('queued','sent','printing'))::int AS load
       FROM printers p
      WHERE p.shop_id = $1 AND p.is_active
        AND ($2::color_mode = 'bw' OR p.supports_color)
        AND ($3::print_sides = 'single' OR p.supports_duplex)
        AND $4::paper_size = ANY (p.paper_sizes)`,
    [shopId, o.color_mode, o.sides, o.paper_size]
  );
  if (!r.rows.length) throw new HttpError(400, 'This shop has no printer for that option. Try a different one');
  const live = r.rows.filter((p) => isAgentOnline(p.agent_id)).sort((a, b) => a.load - b.load);
  if (!live.length) throw new HttpError(503, "The shop's printer is offline right now. Please try again in a few minutes");
  return live[0].id;
}

router.patch('/orders/:id/options', wrap(async (req, res) => {
  const order = await loadOrder(req.params.id);
  if (!editable(order)) throw new HttpError(409, 'This order can no longer be changed');
  if (!order.total_pages) throw new HttpError(400, 'Upload your file first');
  const b = req.body ?? {};
  const color_mode = b.colorMode;
  const paper_size = b.paperSize ?? 'A4';
  const sides = b.sides ?? 'single';
  const copies = Number(b.copies ?? 1);
  if (!COLORS.includes(color_mode)) throw new HttpError(400, 'Choose color or black & white');
  if (!SIZES.includes(paper_size)) throw new HttpError(400, 'Choose a paper size');
  if (!SIDES.includes(sides)) throw new HttpError(400, 'Choose single or double sided');
  if (!Number.isInteger(copies) || copies < 1 || copies > 500) throw new HttpError(400, 'Copies must be between 1 and 500');

  let page_from = b.pageFrom == null || b.pageFrom === '' ? null : Number(b.pageFrom);
  let page_to = b.pageTo == null || b.pageTo === '' ? null : Number(b.pageTo);
  if (page_from != null || page_to != null) {
    page_from ??= 1;
    page_to ??= order.total_pages;
    if (!Number.isInteger(page_from) || !Number.isInteger(page_to) || page_from < 1 || page_to > order.total_pages || page_from > page_to)
      throw new HttpError(400, `Page range must be between 1 and ${order.total_pages}`);
  }

  const next = { ...order, color_mode, paper_size, sides, copies, page_from, page_to };
  const printerId = await pickPrinter(order.shop_id, next);
  const amount = await priceOrder({ query: q }, order.shop_id, next);

  await tx(async (c) => {
    await c.query(
      `UPDATE orders SET color_mode = $2, paper_size = $3, sides = $4, copies = $5, page_from = $6, page_to = $7,
              printer_id = $8, amount = $9, status = 'awaiting_payment', payment_method = NULL,
              expires_at = now() + interval '30 minutes' WHERE id = $1`,
      [order.id, color_mode, paper_size, sides, copies, page_from, page_to, printerId, amount]
    );
    await invalidatePending(c, order.id);
  });
  res.json({ amount, pages: (page_to ?? order.total_pages) - (page_from ?? 1) + 1, copies });
}));

router.post('/orders/:id/pay', createLimiter, wrap(async (req, res) => {
  const order = await loadOrder(req.params.id);
  if (order.status !== 'awaiting_payment' || !order.amount) throw new HttpError(409, 'Choose your print options first');
  const shop = (await q('SELECT s.*, sub.status AS sub_status, sub.current_period_end FROM shops s LEFT JOIN subscriptions sub ON sub.shop_id = s.id WHERE s.id = $1', [order.shop_id])).rows[0];
  const reason = closedReason(shop);
  if (reason) throw new HttpError(403, reason);

  const method = String(req.body?.method ?? '');
  if (!availableProviders().includes(method)) throw new HttpError(400, 'Choose a payment method');

  if (method === 'mock') {
    if (!config.enableMockPayments) throw new HttpError(400, 'Choose a payment method');
    const p = await createPayment({ query: q }, { order, provider: 'mock' });
    return res.json({ kind: 'redirect', url: `/pay/mock/${p.id}` });
  }

  const acct = (await q(`SELECT * FROM shop_payment_accounts WHERE shop_id = $1 AND provider = $2 AND is_active`, [order.shop_id, method])).rows[0];
  if (!acct) throw new HttpError(400, 'This shop does not accept that payment method');

  if (method === 'cash') {
    await q(`UPDATE payments SET status = 'failed' WHERE order_id = $1 AND status = 'pending' AND provider = 'cash'`, [order.id]);
    await createPayment({ query: q }, { order, provider: 'cash' });
    await q(`UPDATE orders SET payment_method = 'cash', expires_at = now() + interval '2 hours' WHERE id = $1`, [order.id]);
    return res.json({ kind: 'cash', orderId: order.id });
  }

  let creds;
  try {
    creds = decrypt(acct.credentials_encrypted);
  } catch {
    throw new HttpError(500, 'This payment method is not set up correctly. Use another method');
  }
  const payment = await createPayment({ query: q }, { order, provider: method });
  const returnUrl = `${config.publicUrl}/api/webhooks/${method}/${order.shop_id}?p=${payment.id}`;
  res.json(providers[method].createCheckout({ payment, order, creds, returnUrl }));
}));

router.get('/orders/:id', wrap(async (req, res) => {
  const o = await loadOrder(req.params.id);
  const s = (await q('SELECT name, slug, phone FROM shops WHERE id = $1', [o.shop_id])).rows[0];
  const f = (await q('SELECT original_name FROM order_files WHERE order_id = $1', [o.id])).rows[0];
  const printer = o.printer_id ? (await q('SELECT display_name FROM printers WHERE id = $1', [o.printer_id])).rows[0] : null;
  res.json({
    id: o.id,
    code: o.public_code,
    status: o.status,
    paymentStatus: o.payment_status,
    paymentMethod: o.payment_method,
    awaitingCash: o.status === 'awaiting_payment' && o.payment_method === 'cash',
    amount: o.amount,
    pages: o.total_pages,
    copies: o.copies,
    colorMode: o.color_mode,
    sides: o.sides,
    paperSize: o.paper_size,
    fileName: f?.original_name ?? null,
    printerName: printer?.display_name ?? null,
    hasProblem: o.status === 'failed',
    shop: { name: s.name, slug: s.slug, phone: s.phone },
  });
}));

export default router;
