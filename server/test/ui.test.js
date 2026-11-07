// Smoke-tests every web page: loads the real HTML, runs the page's JS against the real server in jsdom,
// and checks that it renders without throwing. (Not a visual test.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://printsaas:printsaas@localhost:5432/printsaas_test';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
process.env.ENCRYPTION_KEY = 'bb'.repeat(32);
process.env.ADMIN_EMAIL = 'admin@ui.dev';
process.env.ADMIN_PASSWORD = 'AdminPass12345';
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-ui-'));
process.env.ENABLE_MOCK_PAYMENTS = 'true';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '..', 'public');
const { JSDOM } = await import('jsdom');
const { pool, q } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/index.js');

const nodeFetch = globalThis.fetch;
let server, base;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, url, { token, json } = {}) {
  const res = await nodeFetch(base + url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

let n = 0;
async function loadPage(htmlFile, urlPath, script, { storage = {} } = {}) {
  const html = fs.readFileSync(path.join(pub, htmlFile), 'utf8');
  const dom = new JSDOM(html, { url: base + urlPath, pretendToBeVisual: true });
  const w = dom.window;
  for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
  const errors = [];
  const define = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  define('window', w);
  for (const k of ['document', 'location', 'localStorage', 'navigator', 'FormData', 'Blob', 'File', 'HTMLElement']) define(k, w[k]);
  define('confirm', () => true);
  define('fetch', (u, o) => nodeFetch(new URL(u, base), o));
  w.addEventListener('error', (e) => errors.push(e.error || e.message));
  await import(pathToFileURL(path.join(pub, 'assets', script)).href + `?run=${++n}`);
  await sleep(700);
  return { w, doc: w.document, text: w.document.body.textContent, errors };
}

before(async () => {
  await q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(async () => { await new Promise((r) => server.close(r)); await pool.end(); process.exit(0); });

test('static pages are served and carry security headers', async () => {
  for (const p of ['/', '/login', '/dashboard', '/admin']) {
    const r = await nodeFetch(base + p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  }
  const html = await (await nodeFetch(base + '/dashboard')).text();
  assert.ok(!/<script(?![^>]*src=)/.test(html), 'no inline scripts (CSP-safe)');
});

let token, orderId;
test('login page renders and signup works through its form', async () => {
  const page = await loadPage('login.html', '/login', 'login.js');
  assert.deepEqual(page.errors, []);
  assert.match(page.text, /Shop sign in/);
  const r = await api('POST', '/api/auth/signup', { json: { shopName: 'UI Prints', slug: 'ui-prints', email: 'ui@test.dev', password: 'password123', city: 'Karachi' } });
  token = r.data.token;
});

test('customer page renders shop, offline notice and Urdu toggle', async () => {
  const page = await loadPage('customer.html', '/s/ui-prints', 'customer.js');
  assert.deepEqual(page.errors, []);
  assert.match(page.text, /UI Prints/);
  assert.match(page.text, /Printer offline/);
  assert.match(page.text, /Choose your file/);
  page.doc.querySelector('.lang').click();
  assert.equal(page.doc.documentElement.dir, 'rtl');
  assert.match(page.doc.body.textContent, /اپنی فائل چنیں/);

  const missing = await loadPage('customer.html', '/s/nope-shop', 'customer.js');
  assert.match(missing.text, /could not find this shop/);
});

test('order status page renders a cash order', async () => {
  const o = await api('POST', '/api/public/shops/ui-prints/orders', { json: {} });
  orderId = o.data.orderId;
  await q(`UPDATE orders SET status = 'awaiting_payment', payment_method = 'cash', amount = 45, total_pages = 3 WHERE id = $1`, [orderId]);
  const page = await loadPage('order.html', `/o/${orderId}`, 'order.js');
  assert.deepEqual(page.errors, []);
  assert.match(page.text, new RegExp(o.data.code));
  assert.match(page.text, /Pay Rs 45 at the counter/);
});

test('shop dashboard renders every tab', async () => {
  const storage = { shopToken: token };
  for (const tab of ['Orders', 'Printers', 'Prices', 'Payments', 'Shop & QR']) {
    const page = await loadPage('dashboard.html', '/dashboard', 'dashboard.js', { storage });
    assert.deepEqual(page.errors, [], tab);
    const btn = [...page.doc.querySelectorAll('.tabs button')].find((b) => b.textContent === tab);
    assert.ok(btn, `tab ${tab} exists`);
    btn.click();
    await sleep(500);
    assert.equal(page.doc.querySelector('#content .notice.bad')?.textContent ?? null, null, `${tab} shows no error`);
    if (tab === 'Orders') assert.match(page.doc.body.textContent, /Cash received/);
    if (tab === 'Prices') assert.match(page.doc.body.textContent, /Price per page/);
    if (tab === 'Payments') assert.match(page.doc.body.textContent, /JazzCash/);
    if (tab === 'Shop & QR') assert.ok(page.doc.querySelector('img.qr'));
  }
});

test('admin page logs in and lists shops', async () => {
  const login = await api('POST', '/api/auth/admin/login', { json: { email: 'admin@ui.dev', password: 'AdminPass12345' } });
  const page = await loadPage('admin.html', '/admin', 'admin.js', { storage: { adminToken: login.data.token } });
  assert.deepEqual(page.errors, []);
  assert.match(page.text, /UI Prints/);
  assert.match(page.text, /Plans/);
});

test('QR image endpoint returns a PNG', async () => {
  const r = await nodeFetch(base + '/qr/ui-prints.png');
  assert.equal(r.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.subarray(1, 4).toString(), 'PNG');
});
