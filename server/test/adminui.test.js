// The admin panel screens in jsdom against a real server: real clicks, real changes in the database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://printsaas:printsaas@localhost:5432/printsaas_test';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
process.env.ENCRYPTION_KEY = 'ee'.repeat(32);
process.env.ADMIN_EMAIL = 'ui@admin.dev';
process.env.ADMIN_PASSWORD = 'AdminPass12345';
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-adminui-'));

const noStray = (text, where) => assert.doesNotMatch(text, /(null|undefined|false)/, `stray "null/false/undefined" text on ${where}`);
const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const { JSDOM } = await import('jsdom');
const { pool, q } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/index.js');

const nodeFetch = globalThis.fetch;
let server, base, adminToken, n = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (method, url, { token, json } = {}) => {
  const res = await nodeFetch(base + url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};
const signup = (slug) => api('POST', '/api/auth/signup', { json: { shopName: `Shop ${slug}`, slug, email: `${slug}@t.dev`, password: 'password123', city: 'Karachi' } });
const shopRow = async (slug) => (await q(`SELECT s.id, s.status, sub.status AS sub_status, sub.current_period_end FROM shops s JOIN subscriptions sub ON sub.shop_id = s.id WHERE s.slug = $1`, [slug])).rows[0];

async function open(htmlFile, urlPath, script, storage, { confirmAnswer = true } = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(pub, htmlFile), 'utf8'), { url: base + urlPath, pretendToBeVisual: true });
  const w = dom.window;
  for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
  const define = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  for (const k of ['document', 'location', 'localStorage', 'navigator', 'FormData', 'Blob', 'File', 'HTMLElement']) define(k, w[k]);
  define('window', w);
  w.confirm = () => confirmAnswer; define('confirm', w.confirm);
  define('fetch', (u, o) => nodeFetch(new URL(u, base), o));
  const errors = []; w.addEventListener('error', (e) => errors.push(e.error || e.message));
  await import(pathToFileURL(path.join(pub, 'assets', script)).href + `?run=${++n}`);
  await sleep(500);
  const doc = w.document;
  const text = () => doc.body.textContent;
  const button = (label) => [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === label || b.textContent.trim().startsWith(label));
  const tab = async (name) => { [...doc.querySelectorAll('.tabs button')].find((b) => b.textContent.startsWith(name)).click(); await sleep(400); };
  const click = async (label, wait = 500) => { const b = button(label); assert.ok(b, `button "${label}" exists`); b.click(); await sleep(wait); };
  const type = (el, value) => { el.value = value; el.dispatchEvent(new w.Event('input', { bubbles: true })); el.dispatchEvent(new w.Event('change', { bubbles: true })); };
  return { w, doc, errors, text, button, tab, click, type };
}

before(async () => {
  await q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  adminToken = (await api('POST', '/api/auth/admin/login', { json: { email: 'ui@admin.dev', password: 'AdminPass12345' } })).data.token;
  await signup('alpha-shop');
  await signup('beta-shop');
  await signup('gamma-shop');
});
after(async () => { await new Promise((r) => server.close(r)); await pool.end(); setTimeout(() => process.exit(0), 300); });

test('admin login screen signs in with the form', async () => {
  const p = await open('admin.html', '/admin', 'admin.js', {});
  assert.match(p.text(), /Platform admin/);
  const [email, pw] = p.doc.querySelectorAll('input');
  p.type(email, 'ui@admin.dev'); p.type(pw, 'wrong-password');
  p.doc.querySelector('form').dispatchEvent(new p.w.Event('submit', { cancelable: true }));
  await sleep(400);
  assert.match(p.text(), /Email or password is incorrect/);
});

test('overview: counts, and the shops that need attention with one-click actions', async () => {
  await q(`UPDATE shops SET status = 'pending' WHERE slug = 'gamma-shop'`);
  await q(`UPDATE subscriptions SET current_period_end = now() + interval '3 days' WHERE shop_id = (SELECT id FROM shops WHERE slug = 'beta-shop')`);
  await q(`UPDATE subscriptions SET current_period_end = now() - interval '4 days' WHERE shop_id = (SELECT id FROM shops WHERE slug = 'alpha-shop')`);
  const p = await open('admin.html', '/admin', 'admin.js', { adminToken });
  assert.deepEqual(p.errors, []);
  const t = p.text();
  assert.match(t, /Waiting for approval/); assert.match(t, /Shop gamma-shop/);
  assert.match(t, /Free trial ends within 7 days/); assert.match(t, /Shop beta-shop/); assert.match(t, /3 days left/);
  assert.match(t, /Expired: closed to customers/); assert.match(t, /Shop alpha-shop/); assert.match(t, /ended 4 days ago/);
  assert.match(p.doc.querySelector('.tabs button:nth-child(2)').textContent, /Shops\s*1/, 'badge shows 1 shop waiting');

  await p.click('Approve');
  assert.equal((await shopRow('gamma-shop')).status, 'active', 'approved with one click');

  const before = (await shopRow('alpha-shop')).current_period_end;
  await p.click('+7 days trial');
  const after_ = (await shopRow('alpha-shop')).current_period_end;
  assert.ok(new Date(after_) > new Date(), 'expired shop is open again');
  assert.ok(new Date(after_) > new Date(before));
});

test('shops list: search and filter', async () => {
  const p = await open('admin.html', '/admin', 'admin.js', { adminToken });
  await p.tab('Shops');
  noStray(p.text(), 'shops list');
  assert.match(p.text(), /Shop alpha-shop/); assert.match(p.text(), /Shop beta-shop/); assert.match(p.text(), /Shop gamma-shop/);
  p.type(p.doc.querySelector('input[aria-label="Search shops"]'), 'beta');
  assert.match(p.text(), /Shop beta-shop/); assert.doesNotMatch(p.text(), /Shop alpha-shop/);
  p.type(p.doc.querySelector('input[aria-label="Search shops"]'), 'nobody-like-this');
  assert.match(p.text(), /No shops match/);
  p.type(p.doc.querySelector('input[aria-label="Search shops"]'), 'beta-shop@t.dev'); // search by owner email
  assert.match(p.text(), /Shop beta-shop/);
  p.type(p.doc.querySelector('input[aria-label="Search shops"]'), '');
  const sel = p.doc.querySelector('select[aria-label="Filter by status"]');
  assert.match(sel.textContent, /Free trial \(3\)/);
  sel.value = 'trial'; sel.dispatchEvent(new p.w.Event('change'));
  assert.match(p.text(), /Shop alpha-shop/);
});

test('shop page: extend the trial, mark paid, suspend, note, reset password, all from buttons', async () => {
  const p = await open('admin.html', '/admin', 'admin.js', { adminToken });
  await p.tab('Shops');
  [...p.doc.querySelectorAll('tbody tr')].find((r) => r.textContent.includes('Shop beta-shop')).click();
  await sleep(500);
  assert.match(p.text(), /Free trial and subscription/);
  assert.match(p.text(), /3 days left/);
  noStray(p.text(), 'shop page');

  await p.click('+14 days');
  assert.match(p.text(), /17 days left/);
  assert.match(p.doc.querySelector('.toast')?.textContent ?? '', /Added 14 days/);

  await p.click('Mark paid +30 days');
  assert.equal((await shopRow('beta-shop')).sub_status, 'active');
  assert.match(p.text(), /Paid/);

  p.doc.querySelector('textarea').value = 'Pays in cash, ask for 5000';
  await p.click('Save note');
  assert.equal((await q(`SELECT admin_note FROM shops WHERE slug = 'beta-shop'`)).rows[0].admin_note, 'Pays in cash, ask for 5000');

  await p.click('Reset owner password');
  assert.match(p.text(), /New password for beta-shop@t\.dev/);
  const pw = p.doc.querySelector('.secret').textContent;
  assert.match(pw, /^[0-9a-f]{10}$/);
  assert.equal((await api('POST', '/api/auth/login', { json: { email: 'beta-shop@t.dev', password: pw } })).status, 200);

  await p.click('Suspend shop');
  assert.equal((await shopRow('beta-shop')).status, 'suspended');
  assert.match(p.text(), /Suspended: the owner cannot sign in/);
  await p.click('Reactivate shop');
  assert.equal((await shopRow('beta-shop')).status, 'active');
  assert.match(p.text(), /Admin activity on this shop/);
});

test('delete shop: the button stays off until the shop link is typed', async () => {
  const p = await open('admin.html', '/admin', 'admin.js', { adminToken });
  await p.tab('Shops');
  [...p.doc.querySelectorAll('tbody tr')].find((r) => r.textContent.includes('Shop gamma-shop')).click();
  await sleep(500);
  const del = p.button('Delete this shop for good');
  assert.equal(del.disabled, true);
  const box = p.doc.querySelector('input[aria-label="Type the shop link to confirm"]');
  p.type(box, 'gamma');
  assert.equal(del.disabled, true);
  p.type(box, 'gamma-shop');
  assert.equal(del.disabled, false);
  del.click();
  await sleep(600);
  assert.equal(await shopRow('gamma-shop'), undefined);
  assert.match(p.text(), /Shop alpha-shop/, 'back on the shop list');
});

test('plans: edit a plan inline; settings: change the trial length and contact details', async () => {
  const p = await open('admin.html', '/admin', 'admin.js', { adminToken });
  await p.tab('Plans');
  const row = [...p.doc.querySelectorAll('tbody tr')].find((r) => r.textContent.includes('Basic'));
  row.querySelector('button').click(); await sleep(100);
  const inputs = [...p.doc.querySelectorAll('tbody tr input')];
  p.type(inputs[0], 'Basic'); p.type(inputs[1], '1800'); p.type(inputs[2], '2');
  await p.click('Save');
  assert.deepEqual((await q(`SELECT price_monthly, max_printers FROM plans WHERE name = 'Basic'`)).rows[0], { price_monthly: 1800, max_printers: 2 });

  noStray(p.text(), 'plans');
  await p.tab('Settings');
  noStray(p.text(), 'settings');
  const [days, contact] = [...p.doc.querySelectorAll('section input')].filter((i) => i.type !== 'checkbox');
  p.type(days, '21'); p.type(contact, 'WhatsApp 0300 1112223');
  await p.click('Save settings');
  assert.match(p.doc.querySelector('.toast')?.textContent ?? '', /Settings saved/);
  const s = await api('GET', '/api/admin/settings', { token: adminToken });
  assert.equal(s.data.defaultTrialDays, 21);
  assert.equal(s.data.contactInfo, 'WhatsApp 0300 1112223');

  await p.tab('Activity');
  assert.match(p.text(), /Changed settings/); assert.match(p.text(), /Marked as paid/); assert.match(p.text(), /ui@admin\.dev/);
  noStray(p.text(), 'activity');
});

test('the shop owner sees how many trial days are left, and how to reach you when it has ended', async () => {
  await api('PUT', '/api/admin/settings', { token: adminToken, json: { contactInfo: 'WhatsApp 0300 1112223' } });
  const login = (await api('POST', '/api/auth/login', { json: { email: 'alpha-shop@t.dev', password: 'password123' } })).data.token;
  const dash = async () => (await open('dashboard.html', '/dashboard', 'dashboard.js', { shopToken: login })).doc.querySelector('#banner')?.textContent ?? '';

  await q(`UPDATE subscriptions SET status = 'trialing', current_period_end = now() + interval '40 days' WHERE shop_id = (SELECT id FROM shops WHERE slug = 'alpha-shop')`);
  assert.equal(await dash(), '', 'no banner while the trial is long');
  const quiet = await open('dashboard.html', '/dashboard', 'dashboard.js', { shopToken: login });
  noStray(quiet.text(), 'dashboard without a banner');
  await q(`UPDATE subscriptions SET current_period_end = now() + interval '2 days' WHERE shop_id = (SELECT id FROM shops WHERE slug = 'alpha-shop')`);
  assert.match(await dash(), /free trial ends in 2 days.*WhatsApp 0300 1112223/);
  await q(`UPDATE subscriptions SET current_period_end = now() - interval '1 day' WHERE shop_id = (SELECT id FROM shops WHERE slug = 'alpha-shop')`);
  assert.match(await dash(), /free trial has ended, so customers cannot place orders.*WhatsApp 0300 1112223/);
});
