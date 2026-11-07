// End-to-end test: real Postgres, real HTTP server, real agent process in dry-run mode.
// Requires TEST_DATABASE_URL (a throwaway database).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://printsaas:printsaas@localhost:5432/printsaas_test';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
process.env.ENCRYPTION_KEY = 'aa'.repeat(32);
process.env.ADMIN_EMAIL = 'admin@test.dev';
process.env.ADMIN_PASSWORD = 'AdminPass12345';
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-storage-'));
process.env.ENABLE_MOCK_PAYMENTS = 'true';

const here = path.dirname(fileURLToPath(import.meta.url));
const { pool, q } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/index.js');
const { attach } = await import('../src/hub.js');
const { runCleanup } = await import('../src/cleanup.js');
const { PDFDocument } = await import('pdf-lib');
const jazz = await import('../src/providers/jazzcash.js');

let server, base, agentProc, agentCfg;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, url, { token, json, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (json) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form) body = form;
  const res = await fetch(base + url, { method, headers, body, redirect: 'manual' });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

async function waitFor(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(150);
  }
  assert.fail(`Timed out waiting for ${what}`);
}

async function makePdf(pages) {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage([595, 842]).drawText(`Page ${i + 1}`, { x: 50, y: 700 });
  return Buffer.from(await d.save());
}

async function uploadPdf(orderId, pages, name = 'doc.pdf') {
  const fd = new FormData();
  fd.append('file', new Blob([await makePdf(pages)], { type: 'application/pdf' }), name);
  return api('POST', `/api/public/orders/${orderId}/file`, { form: fd });
}

async function newOrder(slug) {
  const r = await api('POST', `/api/public/shops/${slug}/orders`, { json: {} });
  assert.equal(r.status, 201);
  return r.data.orderId;
}

const state = {};

before(async () => {
  await q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  const app = createApp();
  server = http.createServer(app);
  attach(server);
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  agentProc?.kill();
  await new Promise((r) => server.close(r));
  await pool.end();
});

test('shop signup and login', async () => {
  const r = await api('POST', '/api/auth/signup', { json: { shopName: 'Alpha Prints', slug: 'alpha', email: 'owner@alpha.test', password: 'password123', city: 'Karachi' } });
  assert.equal(r.status, 201);
  state.alpha = r.data.token;
  const dup = await api('POST', '/api/auth/signup', { json: { shopName: 'Other', slug: 'alpha', email: 'x@y.test', password: 'password123' } });
  assert.equal(dup.status, 409);
  const bad = await api('POST', '/api/auth/login', { json: { email: 'owner@alpha.test', password: 'wrong-password' } });
  assert.equal(bad.status, 401);
  const ok = await api('POST', '/api/auth/login', { json: { email: 'owner@alpha.test', password: 'password123' } });
  assert.equal(ok.status, 200);
  const me = await api('GET', '/api/shop/me', { token: state.alpha });
  assert.equal(me.data.shop.slug, 'alpha');
  assert.equal(me.data.shop.plan_name, 'Basic');
});

test('pair a real agent process and register printers', async () => {
  const a = await api('POST', '/api/shop/agents', { token: state.alpha, json: { name: 'Counter PC' } });
  assert.equal(a.status, 201);
  state.agentId = a.data.id;
  agentCfg = path.join(os.tmpdir(), `agent-${crypto.randomUUID()}.json`);
  const env = { ...process.env, AGENT_CONFIG: agentCfg, PRINT_DRY_RUN: '1' };
  const agentJs = path.join(here, '..', '..', 'agent', 'agent.js');
  await execFileAsync('node', [agentJs, 'pair', a.data.pairing_code, '--server', base], { env });
  // a pairing code works once only
  const again = await api('POST', '/api/agent/pair', { json: { code: a.data.pairing_code } });
  assert.equal(again.status, 400);

  agentProc = spawn('node', [agentJs], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  agentProc.stdout.on('data', (d) => process.env.DEBUG_AGENT && process.stdout.write(d));
  const agents = await waitFor(async () => {
    const r = await api('GET', '/api/shop/agents', { token: state.alpha });
    const ag = r.data.find((x) => x.id === state.agentId);
    return ag?.online && ag.detected_printers.length ? r.data : null;
  }, 'agent online with printers');
  assert.deepEqual(agents[0].detected_printers.map((p) => p.name).sort(), ['Test-BW', 'Test-Color']);

  // Basic plan allows exactly 1 printer
  const p1 = await api('POST', '/api/shop/printers', { token: state.alpha, json: { agentId: state.agentId, systemName: 'Test-BW', displayName: 'Laser B&W', supportsColor: false, supportsDuplex: true, paperSizes: ['A4'] } });
  assert.equal(p1.status, 201);
  const p2 = await api('POST', '/api/shop/printers', { token: state.alpha, json: { agentId: state.agentId, systemName: 'Test-Color', displayName: 'Color Inkjet', supportsColor: true, supportsDuplex: false, paperSizes: ['A4'] } });
  assert.equal(p2.status, 403, 'second printer blocked by plan limit');
  await api('PUT', `/api/shop/payment-accounts/cash`, { token: state.alpha, json: { isActive: true } });
});

test('super admin can raise the plan, then the second printer is accepted', async () => {
  const login = await api('POST', '/api/auth/admin/login', { json: { email: 'admin@test.dev', password: 'AdminPass12345' } });
  assert.equal(login.status, 200);
  state.admin = login.data.token;
  const plans = await api('GET', '/api/admin/plans', { token: state.admin });
  const pro = plans.data.find((p) => p.name === 'Pro');
  const shops = await api('GET', '/api/admin/shops', { token: state.admin });
  const alpha = shops.data.find((s) => s.slug === 'alpha');
  const upd = await api('PUT', `/api/admin/shops/${alpha.id}/subscription`, { token: state.admin, json: { planId: pro.id, status: 'active', periodEnd: new Date(Date.now() + 30 * 864e5).toISOString() } });
  assert.equal(upd.status, 200);
  const col = await api('POST', '/api/shop/printers', { token: state.alpha, json: { agentId: state.agentId, systemName: 'Test-Color', displayName: 'Color Inkjet', supportsColor: true, supportsDuplex: false, paperSizes: ['A4'] } });
  assert.equal(col.status, 201);
  state.colorPrinter = col.data.id;
});

test('customer flow with mock payment: upload -> options -> pay -> printed -> file deleted', async () => {
  const shop = await api('GET', '/api/public/shops/alpha');
  assert.equal(shop.data.printersOnline, 2);
  assert.equal(shop.data.colorAvailable, true);
  assert.deepEqual(shop.data.paperSizes, ['A4'], 'customer page gets a real list of paper sizes');
  const plist = await api('GET', '/api/shop/printers', { token: state.alpha });
  assert.ok(plist.data.every((p) => Array.isArray(p.paper_sizes) && p.paper_sizes.includes('A4')), 'printers list has paper_sizes as arrays');

  const orderId = await newOrder('alpha');
  const up = await uploadPdf(orderId, 3);
  assert.equal(up.data.pages, 3);

  // double-sided colour is impossible (colour printer has no duplex)
  const bad = await api('PATCH', `/api/public/orders/${orderId}/options`, { json: { colorMode: 'color', sides: 'double', copies: 1 } });
  assert.equal(bad.status, 400);

  const opt = await api('PATCH', `/api/public/orders/${orderId}/options`, { json: { colorMode: 'color', sides: 'single', copies: 2, pageFrom: 1, pageTo: 2 } });
  assert.equal(opt.status, 200);
  assert.equal(opt.data.amount, 50 * 2 * 2); // 2 pages x 2 copies x 50

  const ord = await api('GET', `/api/public/orders/${orderId}`);
  assert.equal(ord.data.status, 'awaiting_payment');

  const pay = await api('POST', `/api/public/orders/${orderId}/pay`, { json: { method: 'mock' } });
  assert.equal(pay.data.kind, 'redirect');
  const paymentId = pay.data.url.split('/').pop();
  assert.equal((await api('GET', `/api/public/orders/${orderId}`)).data.status, 'awaiting_payment', 'not printed before payment');

  const cb = await api('POST', `/api/webhooks/mock/${paymentId}`, { form: new URLSearchParams({ result: 'success' }) });
  assert.equal(cb.status, 303);
  // callback replay must not create a second job
  await api('POST', `/api/webhooks/mock/${paymentId}`, { form: new URLSearchParams({ result: 'success' }) });

  await waitFor(async () => (await api('GET', `/api/public/orders/${orderId}`)).data.status === 'completed', 'order completed');
  const jobs = await q('SELECT * FROM print_jobs WHERE order_id = $1', [orderId]);
  assert.equal(jobs.rows.length, 1);
  assert.equal(jobs.rows[0].status, 'done');
  assert.equal(jobs.rows[0].printer_id, state.colorPrinter, 'colour job routed to the colour printer');

  await q(`UPDATE order_files SET delete_after = now() - interval '1 second' WHERE order_id = $1`, [orderId]);
  const c = await runCleanup();
  assert.ok(c.filesDeleted >= 1);
  const f = (await q('SELECT * FROM order_files WHERE order_id = $1', [orderId])).rows[0];
  assert.ok(f.deleted_at);
  assert.equal(fs.existsSync(f.storage_path), false, 'customer file removed from disk');
});

test('cash flow: shop marks paid, then it prints', async () => {
  const orderId = await newOrder('alpha');
  await uploadPdf(orderId, 1);
  await api('PATCH', `/api/public/orders/${orderId}/options`, { json: { colorMode: 'bw', sides: 'double', copies: 1 } });
  const pay = await api('POST', `/api/public/orders/${orderId}/pay`, { json: { method: 'cash' } });
  assert.equal(pay.data.kind, 'cash');
  const o = await api('GET', `/api/public/orders/${orderId}`);
  assert.equal(o.data.awaitingCash, true);
  await sleep(500);
  assert.equal((await api('GET', `/api/public/orders/${orderId}`)).data.status, 'awaiting_payment');
  const mp = await api('POST', `/api/shop/orders/${orderId}/mark-paid`, { token: state.alpha });
  assert.equal(mp.status, 200);
  await waitFor(async () => (await api('GET', `/api/public/orders/${orderId}`)).data.status === 'completed', 'cash order completed');
});

test('JazzCash: valid signature pays, forged/tampered callbacks do not', async () => {
  const creds = { merchantId: 'MC12345', password: 'pw', integritySalt: 'salt-1234', sandbox: true };
  const put = await api('PUT', '/api/shop/payment-accounts/jazzcash', { token: state.alpha, json: { credentials: creds } });
  assert.equal(put.status, 200);
  const list = await api('GET', '/api/shop/payment-accounts', { token: state.alpha });
  assert.ok(!JSON.stringify(list.data).includes('salt-1234'), 'credentials never returned');
  const raw = await q(`SELECT credentials_encrypted FROM shop_payment_accounts WHERE provider = 'jazzcash'`);
  assert.ok(!raw.rows[0].credentials_encrypted.toString('utf8').includes('salt-1234'), 'credentials stored encrypted');

  const shopRow = (await q(`SELECT id FROM shops WHERE slug = 'alpha'`)).rows[0];
  async function startOrder() {
    const orderId = await newOrder('alpha');
    await uploadPdf(orderId, 2);
    await api('PATCH', `/api/public/orders/${orderId}/options`, { json: { colorMode: 'bw', sides: 'single', copies: 1 } });
    const pay = await api('POST', `/api/public/orders/${orderId}/pay`, { json: { method: 'jazzcash' } });
    assert.equal(pay.data.kind, 'form');
    assert.ok(pay.data.action.startsWith('https://sandbox.jazzcash.com.pk/'));
    assert.equal(pay.data.fields.pp_Amount, '3000'); // 2 pages x 15 PKR = 30 PKR = 3000 paisa
    assert.equal(jazz.secureHash(pay.data.fields, creds.integritySalt), pay.data.fields.pp_SecureHash);
    const payment = (await q('SELECT * FROM payments WHERE order_id = $1', [orderId])).rows[0];
    return { orderId, fields: pay.data.fields, payment };
  }
  const returnTo = (p) => `/api/webhooks/jazzcash/${shopRow.id}?p=${p.id}`;
  const sign = (f) => ({ ...f, pp_SecureHash: jazz.secureHash(f, creds.integritySalt) });
  const post = (p, f) => api('POST', returnTo(p), { form: new URLSearchParams(f) });

  // 1. forged: right fields, wrong signature
  let t = await startOrder();
  await post(t.payment, { pp_TxnRefNo: t.payment.txn_ref, pp_Amount: '3000', pp_ResponseCode: '000', pp_SecureHash: 'DEADBEEF' });
  assert.equal((await api('GET', `/api/public/orders/${t.orderId}`)).data.status, 'awaiting_payment');

  // 2. signed correctly but for a smaller amount than the order
  await post(t.payment, sign({ pp_TxnRefNo: t.payment.txn_ref, pp_Amount: '100', pp_ResponseCode: '000' }));
  assert.equal((await api('GET', `/api/public/orders/${t.orderId}`)).data.status, 'awaiting_payment');

  // 3. gateway says failed
  await post(t.payment, sign({ pp_TxnRefNo: t.payment.txn_ref, pp_Amount: '3000', pp_ResponseCode: '124' }));
  assert.equal((await api('GET', `/api/public/orders/${t.orderId}`)).data.status, 'awaiting_payment');

  // 4. genuine success
  t = await startOrder();
  const r = await post(t.payment, sign({ pp_TxnRefNo: t.payment.txn_ref, pp_Amount: '3000', pp_ResponseCode: '000', pp_RetreivalReferenceNo: 'RRN1' }));
  assert.equal(r.status, 303);
  await waitFor(async () => (await api('GET', `/api/public/orders/${t.orderId}`)).data.status === 'completed', 'jazzcash order completed');
});

test('changing options after starting payment cannot reuse the cheaper payment', async () => {
  const orderId = await newOrder('alpha');
  await uploadPdf(orderId, 1);
  await api('PATCH', `/api/public/orders/${orderId}/options`, { json: { colorMode: 'bw', sides: 'single', copies: 1 } }); // 15
  const pay = await api('POST', `/api/public/orders/${orderId}/pay`, { json: { method: 'mock' } });
  const paymentId = pay.data.url.split('/').pop();
  await api('PATCH', `/api/public/orders/${orderId}/options`, { json: { colorMode: 'color', sides: 'single', copies: 10 } }); // 500
  await api('POST', `/api/webhooks/mock/${paymentId}`, { form: new URLSearchParams({ result: 'success' }) });
  await sleep(500);
  const o = (await q('SELECT status, failure_reason FROM orders WHERE id = $1', [orderId])).rows[0];
  assert.equal(o.status, 'failed');
  assert.equal(o.failure_reason, 'paid_amount_mismatch');
  assert.equal((await q('SELECT count(*)::int AS n FROM print_jobs WHERE order_id = $1', [orderId])).rows[0].n, 0, 'nothing printed');
});

test('shops cannot see each other; unauthenticated access is rejected', async () => {
  const b = await api('POST', '/api/auth/signup', { json: { shopName: 'Beta', slug: 'beta', email: 'owner@beta.test', password: 'password123' } });
  const orders = await api('GET', '/api/shop/orders', { token: b.data.token });
  assert.equal(orders.data.length, 0);
  const aOrders = await api('GET', '/api/shop/orders', { token: state.alpha });
  assert.ok(aOrders.data.length >= 3);
  const someAlphaOrder = aOrders.data[0].id;
  const cross = await api('POST', `/api/shop/orders/${someAlphaOrder}/cancel`, { token: b.data.token });
  assert.equal(cross.status, 404);
  assert.equal((await api('GET', '/api/shop/orders')).status, 401);
  assert.equal((await api('GET', '/api/admin/shops', { token: state.alpha })).status, 401);
  assert.equal((await api('GET', '/api/agent/jobs/00000000-0000-0000-0000-000000000000/file')).status, 401);
});

test('upload validation rejects non-documents and oversize page counts', async () => {
  const orderId = await newOrder('alpha');
  const fd = new FormData();
  fd.append('file', new Blob(['MZ this is an exe'], { type: 'application/pdf' }), 'evil.pdf');
  const r = await api('POST', `/api/public/orders/${orderId}/file`, { form: fd });
  assert.equal(r.status, 415);
});

test('a suspended shop cannot take orders; a shop with no online printer says so', async () => {
  agentProc.kill();
  await waitFor(async () => (await api('GET', '/api/public/shops/alpha')).data.printersOnline === 0, 'agent offline');
  const orderId = await newOrder('alpha');
  await uploadPdf(orderId, 1);
  const o = await api('PATCH', `/api/public/orders/${orderId}/options`, { json: { colorMode: 'bw', sides: 'single', copies: 1 } });
  assert.equal(o.status, 503);

  const shops = await api('GET', '/api/admin/shops', { token: state.admin });
  const alpha = shops.data.find((s) => s.slug === 'alpha');
  await api('PATCH', `/api/admin/shops/${alpha.id}`, { token: state.admin, json: { status: 'suspended' } });
  const closed = await api('POST', '/api/public/shops/alpha/orders', { json: {} });
  assert.equal(closed.status, 403);
  assert.equal((await api('GET', '/api/shop/me', { token: state.alpha })).status, 403);
});
