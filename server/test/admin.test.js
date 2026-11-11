// Admin panel API against a real server and database: trials, subscriptions, shop management, settings, audit.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://printsaas:printsaas@localhost:5432/printsaas_test';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
process.env.ENCRYPTION_KEY = 'dd'.repeat(32);
process.env.ADMIN_EMAIL = 'boss@admin.dev';
process.env.ADMIN_PASSWORD = 'AdminPass12345';
const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-admin-'));
process.env.STORAGE_DIR = STORAGE;

const { pool, q } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/index.js');

let server, base, admin;
const api = async (method, url, { token, json } = {}) => {
  const res = await fetch(base + url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};
const A = (method, url, json) => api(method, url, { token: admin, json });
const signup = (slug, extra = {}) => api('POST', '/api/auth/signup', { json: { shopName: `Shop ${slug}`, slug, email: `${slug}@t.dev`, password: 'password123', ...extra } });
const shopByslug = async (slug) => (await A('GET', '/api/admin/shops')).data.find((s) => s.slug === slug);
const expire = (slug, interval = '2 days') => q(`UPDATE subscriptions SET current_period_end = now() - interval '${interval}' WHERE shop_id = (SELECT id FROM shops WHERE slug = $1)`, [slug]);

before(async () => {
  await q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  admin = (await api('POST', '/api/auth/admin/login', { json: { email: 'boss@admin.dev', password: 'AdminPass12345' } })).data.token;
});
after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('migrations: applied once, and a database deployed before the admin panel is upgraded in place', async () => {
  assert.equal((await q(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '002_admin_panel.sql'`)).rows[0].n, 1);
  await migrate(); // second run changes nothing
  assert.equal((await q(`SELECT count(*)::int AS n FROM schema_migrations`)).rows[0].n, 1);

  // Pretend this is the database that is already live on Render: no settings/audit tables, no note column.
  await q(`DROP TABLE settings; DROP TABLE admin_audit; ALTER TABLE shops DROP COLUMN admin_note; DROP TABLE schema_migrations;`);
  await migrate();
  const t = await q(`SELECT to_regclass('public.settings') AS s, to_regclass('public.admin_audit') AS a`);
  assert.ok(t.rows[0].s && t.rows[0].a, 'tables recreated');
  await q('SELECT admin_note FROM shops'); // column exists again
});

test('every admin endpoint needs an admin login; a shop login is not enough', async () => {
  const shop = await signup('auth-check');
  for (const [m, u] of [['GET', '/api/admin/overview'], ['GET', '/api/admin/shops'], ['GET', '/api/admin/settings'], ['GET', '/api/admin/audit'], ['GET', '/api/admin/plans']]) {
    assert.equal((await api(m, u)).status, 401, `${u} without login`);
    assert.equal((await api(m, u, { token: shop.data.token })).status, 401, `${u} with a shop token`);
  }
  assert.equal((await api('DELETE', `/api/admin/shops/${(await shopByslug('auth-check')).id}`, { token: shop.data.token, json: { confirmSlug: 'auth-check' } })).status, 401);
});

test('settings: validated, saved, and used by sign-up (trial length, approval, closing sign-ups, default plan)', async () => {
  const d = (await A('GET', '/api/admin/settings')).data;
  assert.equal(d.defaultTrialDays, 14);
  assert.equal(d.signupsEnabled, true);
  assert.equal((await A('PUT', '/api/admin/settings', { defaultTrialDays: 0 })).status, 400);
  assert.equal((await A('PUT', '/api/admin/settings', { requireApproval: 'yes' })).status, 400);
  assert.equal((await A('PUT', '/api/admin/settings', { defaultPlanId: '11111111-1111-4111-8111-111111111111' })).status, 400);
  assert.equal((await A('PUT', '/api/admin/settings', {})).status, 400);

  const saved = await A('PUT', '/api/admin/settings', { defaultTrialDays: 3, contactInfo: '  WhatsApp 0300-1234567  ' });
  assert.equal(saved.data.defaultTrialDays, 3);
  assert.equal(saved.data.contactInfo, 'WhatsApp 0300-1234567');
  await signup('three-day');
  const s = await shopByslug('three-day');
  assert.equal(s.days_left, 3);
  assert.equal(s.state, 'trial');
  const me = await api('POST', '/api/auth/login', { json: { email: 'three-day@t.dev', password: 'password123' } });
  assert.equal((await api('GET', '/api/shop/me', { token: me.data.token })).data.support, 'WhatsApp 0300-1234567');

  // approval required: new shop waits, cannot take orders until approved
  await A('PUT', '/api/admin/settings', { requireApproval: true });
  await signup('needs-ok');
  let n = await shopByslug('needs-ok');
  assert.equal(n.state, 'pending');
  assert.equal((await api('POST', '/api/public/shops/needs-ok/orders', { json: {} })).status, 403);
  assert.equal((await A('PATCH', `/api/admin/shops/${n.id}`, { status: 'active' })).status, 200);
  n = await shopByslug('needs-ok');
  assert.equal(n.state, 'trial');
  assert.equal((await api('POST', '/api/public/shops/needs-ok/orders', { json: {} })).status, 201);

  // sign-ups closed
  await A('PUT', '/api/admin/settings', { signupsEnabled: false });
  assert.equal((await signup('too-late')).status, 403);
  await A('PUT', '/api/admin/settings', { signupsEnabled: true, requireApproval: false, defaultTrialDays: 14 });
  assert.equal((await signup('open-again')).status, 201);

  // default plan
  const plans = (await A('GET', '/api/admin/plans')).data;
  const pro = plans.find((p) => p.name === 'Pro');
  assert.equal((await A('PUT', '/api/admin/settings', { defaultPlanId: pro.id })).status, 200);
  await signup('gets-pro');
  assert.equal((await shopByslug('gets-pro')).plan_name, 'Pro');
  await A('PUT', '/api/admin/settings', { defaultPlanId: null });
  await signup('gets-cheapest');
  assert.equal((await shopByslug('gets-cheapest')).plan_name, 'Basic');
});

test('trials: an expired shop is closed to customers; extending the trial or marking it paid opens it again', async () => {
  await signup('trial-end');
  const id = (await shopByslug('trial-end')).id;
  assert.equal((await api('POST', '/api/public/shops/trial-end/orders', { json: {} })).status, 201);

  await expire('trial-end');
  let s = await shopByslug('trial-end');
  assert.equal(s.state, 'expired');
  assert.ok(s.days_left <= -2);
  assert.equal((await api('POST', '/api/public/shops/trial-end/orders', { json: {} })).status, 403, 'customers cannot order');
  const ov = (await A('GET', '/api/admin/overview')).data;
  assert.ok(ov.counts.expired >= 1);
  assert.ok(ov.attention.expired.some((x) => x.slug === 'trial-end'));

  assert.equal((await A('POST', `/api/admin/shops/${id}/extend`, { days: 0 })).status, 400);
  assert.equal((await A('POST', `/api/admin/shops/${id}/extend`, { days: 5000 })).status, 400);
  const ext = await A('POST', `/api/admin/shops/${id}/extend`, { days: 14 });
  assert.equal(ext.status, 200);
  s = await shopByslug('trial-end');
  assert.equal(s.state, 'trial');
  assert.equal(s.days_left, 14, 'counted from today, not from the old end date');
  assert.equal((await api('POST', '/api/public/shops/trial-end/orders', { json: {} })).status, 201);

  await A('POST', `/api/admin/shops/${id}/extend`, { days: 7 }); // adds to the end date
  assert.equal((await shopByslug('trial-end')).days_left, 21);

  await A('POST', `/api/admin/shops/${id}/extend`, { days: 30, markPaid: true });
  s = await shopByslug('trial-end');
  assert.equal(s.state, 'paid');
  assert.equal(s.sub_status, 'active');

  // a cancelled / past-due shop that gets an extension is put back on trial
  await q(`UPDATE subscriptions SET status = 'cancelled' WHERE shop_id = $1`, [id]);
  await A('POST', `/api/admin/shops/${id}/extend`, { days: 5 });
  assert.equal((await shopByslug('trial-end')).sub_status, 'trialing');
});

test('overview lists the shops that need attention', async () => {
  await signup('ends-soon');
  await q(`UPDATE subscriptions SET current_period_end = now() + interval '2 days' WHERE shop_id = (SELECT id FROM shops WHERE slug = 'ends-soon')`);
  await A('PUT', '/api/admin/settings', { requireApproval: true });
  await signup('waiting');
  await A('PUT', '/api/admin/settings', { requireApproval: false });
  const ov = (await A('GET', '/api/admin/overview')).data;
  assert.ok(ov.attention.endingSoon.some((x) => x.slug === 'ends-soon' && x.days_left === 2));
  assert.ok(ov.attention.pending.some((x) => x.slug === 'waiting'));
  assert.ok(ov.total >= 8);
  assert.equal(typeof ov.orders_30d, 'number');
});

test('shop detail, private notes, suspend and reactivate', async () => {
  const s = await shopByslug('three-day');
  assert.equal(s.owner_email, 'three-day@t.dev');
  for (const k of ['state', 'days_left', 'orders', 'printers', 'agents_online', 'revenue', 'plan_name']) assert.ok(k in s, k);

  assert.equal((await A('PATCH', `/api/admin/shops/${s.id}`, { adminNote: 'Paid cash on 5 Nov' })).status, 200);
  assert.equal((await A('PATCH', `/api/admin/shops/${s.id}`, { status: 'nonsense' })).status, 400);
  assert.equal((await A('PATCH', `/api/admin/shops/${s.id}`, {})).status, 400);

  const d = (await A('GET', `/api/admin/shops/${s.id}`)).data;
  assert.equal(d.shop.admin_note, 'Paid cash on 5 Nov');
  assert.equal(d.users[0].role, 'owner');
  assert.ok(Array.isArray(d.orders) && Array.isArray(d.agents) && Array.isArray(d.printers));
  assert.ok(d.activity.some((a) => a.action === 'shop.note'));
  assert.equal((await A('GET', '/api/admin/shops/not-a-uuid')).status, 404);

  const login = (await api('POST', '/api/auth/login', { json: { email: 'three-day@t.dev', password: 'password123' } })).data.token;
  await A('PATCH', `/api/admin/shops/${s.id}`, { status: 'suspended' });
  assert.equal((await shopByslug('three-day')).state, 'suspended');
  assert.equal((await api('GET', '/api/shop/me', { token: login })).status, 403, 'a suspended shop cannot use its dashboard');
  assert.equal((await api('POST', '/api/public/shops/three-day/orders', { json: {} })).status, 403);
  await A('PATCH', `/api/admin/shops/${s.id}`, { status: 'active' });
  assert.equal((await api('GET', '/api/shop/me', { token: login })).status, 200);
});

test('reset owner password: new one works once shown, the old one stops, and it is never written to the log', async () => {
  const s = await shopByslug('gets-pro');
  const r = await A('POST', `/api/admin/shops/${s.id}/reset-password`);
  assert.equal(r.status, 200);
  assert.equal(r.data.email, 'gets-pro@t.dev');
  assert.match(r.data.password, /^[0-9a-f]{10}$/);
  assert.equal((await api('POST', '/api/auth/login', { json: { email: 'gets-pro@t.dev', password: 'password123' } })).status, 401);
  assert.equal((await api('POST', '/api/auth/login', { json: { email: 'gets-pro@t.dev', password: r.data.password } })).status, 200);
  const log = (await A('GET', '/api/admin/audit')).data;
  assert.ok(log.some((x) => x.action === 'owner.password_reset' && x.shop_name === 'Shop gets-pro'));
  assert.ok(!JSON.stringify(log).includes(r.data.password));
});

test('delete shop: needs the shop link typed, removes data and files, keeps the history', async () => {
  const sg = await signup('delete-me');
  const s = await shopByslug('delete-me');
  const dir = path.join(STORAGE, 'orders', s.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'x.pdf'), '%PDF-1.4');
  const o = await api('POST', '/api/public/shops/delete-me/orders', { json: {} });
  assert.equal(o.status, 201);

  assert.equal((await A('DELETE', `/api/admin/shops/${s.id}`, { confirmSlug: 'wrong' })).status, 400);
  assert.equal((await A('DELETE', `/api/admin/shops/${s.id}`, {})).status, 400);
  assert.ok(await shopByslug('delete-me'), 'still there');

  assert.equal((await A('DELETE', `/api/admin/shops/${s.id}`, { confirmSlug: 'delete-me' })).status, 200);
  assert.equal(await shopByslug('delete-me'), undefined);
  assert.equal(fs.existsSync(dir), false, 'uploaded files removed');
  assert.equal((await q('SELECT count(*)::int AS n FROM orders WHERE shop_id = $1', [s.id])).rows[0].n, 0);
  assert.equal((await api('GET', '/api/public/shops/delete-me')).status, 404);
  assert.equal((await api('GET', '/api/shop/me', { token: sg.data.token })).status, 401, 'its logins stop working');
  const log = (await A('GET', '/api/admin/audit')).data;
  assert.ok(log.some((x) => x.action === 'shop.delete' && x.shop_name === 'Shop delete-me'), 'history survives deletion');
});

test('plans: edit all fields, switch on/off, unlimited orders, duplicate names, shop counts', async () => {
  const add = await A('POST', '/api/admin/plans', { name: 'Starter', priceMonthly: 999, maxPrinters: 2, maxOrdersPerMonth: 300 });
  assert.equal(add.status, 201);
  assert.equal((await A('POST', '/api/admin/plans', { name: 'Starter', priceMonthly: 1, maxPrinters: 1 })).status, 409);
  assert.equal((await A('POST', '/api/admin/plans', { name: '', priceMonthly: 1, maxPrinters: 1 })).status, 400);
  assert.equal((await A('POST', '/api/admin/plans', { name: 'Bad', priceMonthly: 1, maxPrinters: 0 })).status, 400);

  const id = add.data.id;
  assert.equal((await A('PUT', `/api/admin/plans/${id}`, { name: 'Starter Plus', priceMonthly: 1200, maxPrinters: 3, maxOrdersPerMonth: '' })).status, 200);
  let p = (await A('GET', '/api/admin/plans')).data.find((x) => x.id === id);
  assert.deepEqual([p.name, p.price_monthly, p.max_printers, p.max_orders_per_month], ['Starter Plus', 1200, 3, null]);

  await A('PUT', `/api/admin/plans/${id}`, { isActive: false }); // only the switch: other fields unchanged
  p = (await A('GET', '/api/admin/plans')).data.find((x) => x.id === id);
  assert.equal(p.is_active, false);
  assert.equal(p.max_printers, 3);
  assert.equal((await A('PUT', '/api/admin/settings', { defaultPlanId: id })).status, 400, 'a turned-off plan cannot be the default');

  const basic = (await A('GET', '/api/admin/plans')).data.find((x) => x.name === 'Basic');
  assert.ok(basic.shops >= 1);
});

test('activity log: newest first, with who did what', async () => {
  const log = (await A('GET', '/api/admin/audit?limit=5')).data;
  assert.equal(log.length, 5);
  assert.ok(log.every((x) => x.admin_email === 'boss@admin.dev'));
  for (let i = 1; i < log.length; i++) assert.ok(new Date(log[i - 1].created_at) >= new Date(log[i].created_at));
  const actions = new Set((await A('GET', '/api/admin/audit?limit=500')).data.map((x) => x.action));
  for (const a of ['settings.change', 'shop.status', 'subscription.extend', 'subscription.paid', 'plan.add', 'plan.edit', 'shop.delete']) assert.ok(actions.has(a), a);
});
