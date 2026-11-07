import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import QRCode from 'qrcode';
import { config } from './config.js';
import { pool, q } from './db.js';
import { migrate } from './migrate.js';
import { errorHandler, wrap, HttpError } from './errors.js';
import { attach } from './hub.js';
import { runCleanup } from './cleanup.js';
import { gatewayFormHosts } from './providers/index.js';
import authRoutes from './routes/auth.js';
import publicRoutes from './routes/public.js';
import shopRoutes from './routes/shop.js';
import adminRoutes from './routes/admin.js';
import agentRoutes from './routes/agent.js';
import webhookRoutes from './routes/webhooks.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '..', 'public');

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // behind Render / nginx
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'"],
          formAction: ["'self'", ...gatewayFormHosts],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          upgradeInsecureRequests: config.isProd ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
    })
  );
  app.use('/api', express.json({ limit: '100kb' }));
  app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 1500, standardHeaders: true, legacyHeaders: false }));

  app.get('/healthz', wrap(async (_req, res) => {
    await q('SELECT 1');
    res.json({ ok: true });
  }));

  app.use('/api/auth', authRoutes);
  app.use('/api/public', publicRoutes);
  app.use('/api/shop', shopRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/agent', agentRoutes);
  app.use('/api/webhooks', webhookRoutes);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

  // Shop QR (encodes only the public order link).
  app.get('/qr/:slug.png', wrap(async (req, res) => {
    const r = await q('SELECT 1 FROM shops WHERE slug = $1', [req.params.slug.toLowerCase()]);
    if (!r.rows.length) throw new HttpError(404, 'Shop not found');
    const png = await QRCode.toBuffer(`${config.publicUrl}/s/${req.params.slug.toLowerCase()}`, { width: 720, margin: 2, errorCorrectionLevel: 'M' });
    res.type('png').set('Cache-Control', 'public, max-age=3600').send(png);
  }));

  // Pages
  const page = (file) => (_req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(pub, file));
  app.get('/s/:slug', page('customer.html'));
  app.get('/o/:id', page('order.html'));
  app.get('/pay/mock/:paymentId', wrap(async (req, res) => {
    if (!config.enableMockPayments) throw new HttpError(404, 'Not found');
    res.set('Cache-Control', 'no-store').sendFile(path.join(pub, 'mockpay.html'));
  }));
  app.get('/api/public/mock/:paymentId', wrap(async (req, res) => {
    if (!config.enableMockPayments) throw new HttpError(404, 'Not found');
    if (!/^[0-9a-f-]{36}$/i.test(req.params.paymentId)) throw new HttpError(404, 'Not found');
    const r = await q(`SELECT p.amount, p.order_id, s.name FROM payments p JOIN shops s ON s.id = p.shop_id WHERE p.id = $1 AND p.provider = 'mock'`, [req.params.paymentId]);
    if (!r.rows.length) throw new HttpError(404, 'Not found');
    res.json(r.rows[0]);
  }));
  app.get('/dashboard', page('dashboard.html'));
  app.get('/admin', page('admin.html'));
  app.get('/login', page('login.html'));
  app.use(express.static(pub, { index: 'index.html', maxAge: config.isProd ? '1h' : 0 }));

  app.use(errorHandler);
  return app;
}

async function main() {
  await migrate();
  const app = createApp();
  const server = http.createServer(app);
  attach(server);
  const timer = setInterval(() => runCleanup().catch((e) => console.error('cleanup failed:', e)), 60_000);
  timer.unref();
  server.listen(config.port, () => console.log(`PrintSaaS running on ${config.publicUrl} (port ${config.port})`));

  const shutdown = () => {
    console.log('Shutting down...');
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
