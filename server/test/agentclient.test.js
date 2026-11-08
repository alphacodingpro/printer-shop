// The agent core used by the tray app, against a real server: pairing, status, reconnect, one-click printer sync.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://printsaas:printsaas@localhost:5432/printsaas_test';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
process.env.ENCRYPTION_KEY = 'cc'.repeat(32);
process.env.ADMIN_EMAIL = 'admin@agent.dev';
process.env.ADMIN_PASSWORD = 'AdminPass12345';
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-agent-'));

const here = path.dirname(fileURLToPath(import.meta.url));
const { pool, q } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/index.js');
const { attach } = await import('../src/hub.js');
const core = await import(pathToFileURL(path.join(here, '..', '..', 'agent', 'src', 'core.js')).href);
const { AgentClient, isVirtualPrinter, normalizeServer } = core;

let server, base, token, agentId, client, cfgFile;
const statuses = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, url, { token: t, json } = {}) {
  const res = await fetch(base + url, { method, headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function waitFor(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100); }
  assert.fail(`Timed out waiting for ${what}`);
}
const newPairingCode = async () => (await api('POST', `/api/shop/agents/${agentId}/pairing`, { token })).data.pairing_code;

before(async () => {
  await q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  server = http.createServer(createApp());
  attach(server);
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(async () => {
  client?.stop();
  await new Promise((r) => server.close(r));
  await pool.end();
  setTimeout(() => process.exit(0), 300);
});

test('helpers: virtual printers are recognised, server addresses are cleaned up', () => {
  for (const n of ['Microsoft Print to PDF', 'Fax', 'Microsoft XPS Document Writer', 'OneNote (Desktop)']) assert.equal(isVirtualPrinter(n), true, n);
  for (const n of ['HP LaserJet Pro M404', 'Brother HL-L2350DW series', 'EPSON L3250 Series', 'Canon iR-ADV C5535']) assert.equal(isVirtualPrinter(n), false, n);
  assert.equal(normalizeServer('printsaas.onrender.com/'), 'https://printsaas.onrender.com');
  assert.equal(normalizeServer(' http://localhost:3000 '), 'http://localhost:3000');
  assert.throws(() => normalizeServer('   '));
});

test('pairing: a wrong code gives a clear error, the right code connects and shows the shop name', async () => {
  const r = await api('POST', '/api/auth/signup', { json: { shopName: 'GUI Shop', slug: 'gui-shop', email: 'gui@test.dev', password: 'password123' } });
  token = r.data.token;
  const a = await api('POST', '/api/shop/agents', { token, json: { name: 'Counter PC' } });
  agentId = a.data.id;

  cfgFile = path.join(os.tmpdir(), `agent-gui-${crypto.randomUUID()}.json`);
  client = new AgentClient({ configPath: cfgFile, dryRun: true });
  client.on('status', (s) => statuses.push(s.status));
  assert.equal(client.state().status, 'unpaired');

  await assert.rejects(() => client.pair(base, 'WRONG-CODE'), /wrong or has expired/);
  await assert.rejects(() => client.pair('http://localhost:1', a.data.pairing_code), /Could not reach the server/);
  assert.equal(client.state().paired, false);

  await client.pair(base, a.data.pairing_code);
  await waitFor(() => client.state().status === 'connected', 'connected');
  assert.equal(client.state().shopName, 'GUI Shop');
  assert.equal(client.state().paired, true);
  assert.ok(statuses.includes('connecting'));
  // the dashboard sees the computer online, with printer capabilities
  const agents = await waitFor(async () => {
    const ag = (await api('GET', '/api/shop/agents', { token })).data.find((x) => x.id === agentId);
    return ag?.online && ag.detected_printers.length ? ag : null;
  }, 'dashboard shows agent online');
  const color = agents.detected_printers.find((p) => p.name === 'Test-Color');
  assert.equal(color.color, true);
  assert.equal(agents.detected_printers.find((p) => p.name === 'Test-BW').duplex, true);
});

test('one click "add all my printers": respects the plan limit, then adds the rest after an upgrade', async () => {
  const first = await client.syncPrinters();
  assert.deepEqual(first.added, ['Test-Color'], 'Basic plan allows one printer');
  assert.deepEqual(first.skipped, ['Test-BW']);
  assert.equal(first.limit, 1);

  const list = (await api('GET', '/api/shop/printers', { token })).data;
  assert.equal(list.length, 1);
  assert.equal(list[0].supports_color, true);
  assert.equal(list[0].supports_duplex, false);
  assert.deepEqual(list[0].paper_sizes, ['A4']);

  await q(`UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE name = 'Pro')`);
  const second = await client.syncPrinters();
  assert.deepEqual(second.added, ['Test-BW']);
  assert.deepEqual(second.existing, ['Test-Color']);
  assert.deepEqual(second.skipped, []);

  const third = await client.syncPrinters(); // clicking again changes nothing
  assert.deepEqual(third.added, []);
  assert.equal((await api('GET', '/api/shop/printers', { token })).data.length, 2);
});

test('sync rejects a bad token and ignores junk input', async () => {
  const res = await fetch(`${base}/api/agent/printers/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' }, body: JSON.stringify({ printers: [{ name: 'X' }] }) });
  assert.equal(res.status, 401);
  const t = JSON.parse(fs.readFileSync(cfgFile, 'utf8')).token;
  const ok = await fetch(`${base}/api/agent/printers/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: JSON.stringify({ printers: [null, {}, { name: '' }, { name: 'Test-BW' }, 'x'] }) });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).added, []);
});

test('options are saved, and test mode switches the printer list', async () => {
  assert.equal(client.state().autoStart, true, 'starts with Windows by default');
  const events = [];
  client.on('option', (n, v) => events.push([n, v]));
  await client.setOption('autoStart', false);
  assert.equal(client.state().autoStart, false);
  assert.deepEqual(events, [['autoStart', false]]);
  await assert.rejects(() => client.setOption('evil', 1), /Unknown option/);
  assert.equal(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).autoStart, false, 'persisted to the config file');
});

test('automatic reconnect: after the connection drops the agent comes back by itself', async () => {
  const before = statuses.length;
  client.ws.terminate(); // simulate Wi-Fi dropping
  await waitFor(() => statuses.slice(before).includes('disconnected'), 'noticed the drop');
  await waitFor(() => client.state().status === 'connected', 'reconnected', 20000);
  const seq = statuses.slice(before);
  assert.ok(seq.indexOf('disconnected') < seq.lastIndexOf('connected'));
  const ag = await waitFor(async () => (await api('GET', '/api/shop/agents', { token })).data.find((x) => x.id === agentId)?.online, 'server sees it online again');
  assert.ok(ag);
});

test('a computer removed in the dashboard stops reconnecting and asks to be paired again', async () => {
  const del = await api('DELETE', `/api/shop/agents/${agentId}`, { token });
  assert.equal(del.status, 200);
  client.ws.terminate();
  await waitFor(() => client.state().status === 'unpaired', 'unpaired after removal', 20000);
  assert.match(client.state().error, /removed from the dashboard/);
  assert.equal(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).token, undefined, 'token forgotten');
});

test('unpair() forgets the shop on this computer', async () => {
  const a = await api('POST', '/api/shop/agents', { token, json: { name: 'Second PC' } });
  await client.pair(base, a.data.pairing_code);
  await waitFor(() => client.state().status === 'connected', 'connected again');
  await client.unpair();
  assert.equal(client.state().status, 'unpaired');
  assert.equal(client.state().paired, false);
  assert.equal(client.state().shopName, null);
});
