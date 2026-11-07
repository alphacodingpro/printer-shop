#!/usr/bin/env node
// PrintSaaS Print Agent.
//   node agent.js pair ABCD-EFGH --server https://your-app.example.com   (once)
//   node agent.js                                                        (run)
//   node agent.js printers                                               (list printers on this PC)
//
// Env: AGENT_CONFIG=<path to config json>, PRINT_DRY_RUN=1 (log instead of printing)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket from 'ws';

const run = promisify(execFile);
const CONFIG_PATH = process.env.AGENT_CONFIG || path.join(os.homedir(), '.printsaas-agent.json');
const DRY_RUN = process.env.PRINT_DRY_RUN === '1';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const loadConfig = () => {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
};
const saveConfig = (c) => fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2), { mode: 0o600 });

// ---------- Printers on this computer ----------
async function listPrinters() {
  if (DRY_RUN) return [{ name: 'Test-Color' }, { name: 'Test-BW' }];
  try {
    if (process.platform === 'win32') {
      const { getPrinters } = await import('pdf-to-printer');
      return (await getPrinters()).map((p) => ({ name: p.name }));
    }
    const { stdout } = await run('lpstat', ['-e']);
    return stdout.split('\n').filter(Boolean).map((name) => ({ name: name.trim() }));
  } catch (e) {
    log('Could not list printers:', e.message);
    return [];
  }
}

// ---------- Printing ----------
const PAPER = { A3: 'A3', A4: 'A4', A5: 'A5', Legal: 'legal', Letter: 'letter' };

async function printPdf(file, job) {
  const o = job.options;
  const range = o.pageFrom || o.pageTo ? `${o.pageFrom ?? 1}-${o.pageTo ?? 9999}` : null;
  if (DRY_RUN) {
    log(`[dry-run] would print ${file} on "${job.printer}"`, JSON.stringify(o));
    await new Promise((r) => setTimeout(r, 300));
    return;
  }
  if (process.platform === 'win32') {
    const { print } = await import('pdf-to-printer');
    await print(file, {
      printer: job.printer,
      copies: o.copies,
      monochrome: o.colorMode === 'bw',
      side: o.sides === 'double' ? 'duplexlong' : 'simplex',
      paperSize: PAPER[o.paperSize],
      ...(range ? { pages: range } : {}),
    });
  } else {
    const args = ['-d', job.printer, '-n', String(o.copies), '-o', `sides=${o.sides === 'double' ? 'two-sided-long-edge' : 'one-sided'}`, '-o', `media=${o.paperSize}`];
    if (o.colorMode === 'bw') args.push('-o', 'print-color-mode=monochrome');
    if (range) args.push('-o', `page-ranges=${range}`);
    await run('lp', [...args, file]);
  }
}

// ---------- Commands ----------
const [, , cmd, ...rest] = process.argv;

if (cmd === 'pair') {
  const code = rest.find((a) => !a.startsWith('--'));
  const server = rest.includes('--server') ? rest[rest.indexOf('--server') + 1] : loadConfig().server;
  if (!code || !server) {
    console.error('Usage: node agent.js pair ABCD-EFGH --server https://your-app.example.com');
    process.exit(1);
  }
  const base = server.replace(/\/$/, '');
  const res = await fetch(`${base}/api/agent/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Pairing failed:', body.error || res.statusText);
    process.exit(1);
  }
  saveConfig({ server: base, token: body.token, done: [] });
  console.log(`Paired with "${body.shopName}". Now run: node agent.js`);
  process.exit(0);
}

if (cmd === 'printers') {
  const list = await listPrinters();
  console.log(list.length ? list.map((p) => `- ${p.name}`).join('\n') : 'No printers found');
  process.exit(0);
}

// ---------- Main loop ----------
const cfg = loadConfig();
if (!cfg.server || !cfg.token) {
  console.error('Not paired yet. Run: node agent.js pair <CODE> --server <URL>');
  process.exit(1);
}
const done = new Set(cfg.done ?? []);
const inflight = new Set();
let chain = Promise.resolve();
let ws;
let attempt = 0;

const wsUrl = cfg.server.replace(/^http/, 'ws') + '/ws/agent';
const send = (obj) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(obj));
const rememberDone = (id) => {
  done.add(id);
  const c = loadConfig();
  c.done = [...done].slice(-200);
  saveConfig(c);
};

async function runJob(job) {
  const tmp = path.join(os.tmpdir(), `printsaas-${job.id}.pdf`);
  try {
    if (done.has(job.id)) return send({ type: 'job:status', jobId: job.id, status: 'done' }); // already printed
    send({ type: 'job:status', jobId: job.id, status: 'printing' });
    log(`Job ${job.orderCode}: downloading`);
    const res = await fetch(`${cfg.server}/api/agent/jobs/${job.id}/file`, { headers: { Authorization: `Bearer ${cfg.token}` } });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    log(`Job ${job.orderCode}: printing on "${job.printer}"`);
    await printPdf(tmp, job);
    rememberDone(job.id);
    send({ type: 'job:status', jobId: job.id, status: 'done' });
    log(`Job ${job.orderCode}: done`);
  } catch (e) {
    log(`Job ${job.orderCode}: FAILED -`, e.message);
    send({ type: 'job:status', jobId: job.id, status: 'failed', error: e.message });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function enqueue(job) {
  if (inflight.has(job.id)) return;
  inflight.add(job.id);
  chain = chain.then(() => runJob(job)).finally(() => inflight.delete(job.id));
}

function connect() {
  ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${cfg.token}` } });
  ws.on('open', async () => {
    attempt = 0;
    log('Connected to', cfg.server);
    send({ type: 'printers', printers: await listPrinters() });
  });
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'job') enqueue(msg.job);
    } catch {
      /* ignore malformed */
    }
  });
  ws.on('unexpected-response', (_req, res) => {
    if (res.statusCode === 401) {
      console.error('This computer is no longer paired. Create a new pairing code in the dashboard.');
      process.exit(1);
    }
  });
  ws.on('close', () => {
    const wait = Math.min(30_000, 1000 * 2 ** attempt++);
    log(`Disconnected. Reconnecting in ${Math.round(wait / 1000)}s`);
    setTimeout(connect, wait);
  });
  ws.on('error', () => {});
}

connect();
setInterval(async () => send({ type: 'printers', printers: await listPrinters() }), 5 * 60_000).unref();
