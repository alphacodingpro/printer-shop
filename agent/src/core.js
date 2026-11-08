// PrintSaaS agent core. Used by both the command-line agent (agent.js) and the tray app (app/main.js).
// No Electron or process.exit in here, so it can be tested on its own.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

const run = promisify(execFile);

// ------------------------------------------------------------------ Printers
const PAPER_BY_CODE = { 1: 'Letter', 5: 'Legal', 8: 'A3', 9: 'A4', 11: 'A5' }; // Windows DMPAPER codes
const KNOWN_SIZES = ['A4', 'A3', 'A5', 'Legal', 'Letter'];

/** Printers that are not real paper printers (PDF writers, fax, ...). Skipped by "add all my printers". */
export const isVirtualPrinter = (name) =>
  /fax|xps|onenote|pdf|document writer|send to|print to file|cloud print|snagit|webex|anydesk|teams|zoom/i.test(name);

const FAKE_PRINTERS = [
  { name: 'Test-Color', isDefault: true, color: true, duplex: false, paperSizes: ['A4'], virtual: false },
  { name: 'Test-BW', isDefault: false, color: false, duplex: true, paperSizes: ['A4'], virtual: false },
];

async function detectWindows() {
  const ps = 'Get-CimInstance Win32_Printer | Select-Object Name,Default,Capabilities,PaperSizesSupported | ConvertTo-Json -Compress';
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      timeout: 25_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    });
    let data = JSON.parse(stdout.trim() || '[]');
    if (!Array.isArray(data)) data = [data];
    return data.filter((p) => p?.Name).map((p) => {
      const caps = p.Capabilities || [];
      const sizes = [...new Set((p.PaperSizesSupported || []).map((c) => PAPER_BY_CODE[c]).filter(Boolean))];
      return { name: p.Name, isDefault: !!p.Default, color: caps.includes(2), duplex: caps.includes(3), paperSizes: sizes.length ? sizes : ['A4'], virtual: isVirtualPrinter(p.Name) };
    });
  } catch {
    // PowerShell blocked? Fall back to just the names.
    const { getPrinters } = await import('pdf-to-printer');
    return (await getPrinters()).map((p) => ({ name: p.name, isDefault: false, color: false, duplex: false, paperSizes: ['A4'], virtual: isVirtualPrinter(p.name) }));
  }
}

async function detectCups() {
  const { stdout } = await run('lpstat', ['-e'], { timeout: 15_000 });
  const names = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  let def = null;
  try { def = (await run('lpstat', ['-d'])).stdout.match(/destination:\s*(\S+)/)?.[1] ?? null; } catch { /* no default */ }
  const out = [];
  for (const name of names) {
    let color = false; let duplex = false; let sizes = [];
    try {
      const { stdout: o } = await run('lpoptions', ['-p', name, '-l'], { timeout: 15_000 });
      duplex = /^\w*Duplex\w*\//m.test(o);
      color = /^(ColorModel|ColorMode|PrintoutMode|print-color-mode)\/[^\n]*\b(RGB|Color|CMYK)\b/im.test(o);
      const size = o.match(/^(PageSize|media)\/[^:]*:(.*)$/m)?.[2] ?? '';
      sizes = KNOWN_SIZES.filter((z) => new RegExp(`(^|\\s|\\*)${z}(\\.|\\s|$)`).test(size));
    } catch { /* keep defaults */ }
    out.push({ name, isDefault: name === def, color, duplex, paperSizes: sizes.length ? sizes : ['A4'], virtual: isVirtualPrinter(name) });
  }
  return out;
}

/** All printers installed on this computer, with best-effort colour / duplex / paper-size detection. */
export async function detectPrinters({ dryRun = false } = {}) {
  if (dryRun) return FAKE_PRINTERS;
  try {
    const list = process.platform === 'win32' ? await detectWindows() : await detectCups();
    return list.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ Printing
const PAPER = { A3: 'A3', A4: 'A4', A5: 'A5', Legal: 'legal', Letter: 'letter' };

export async function printPdf(file, job, { dryRun = false, log = () => {} } = {}) {
  const o = job.options;
  const range = o.pageFrom || o.pageTo ? `${o.pageFrom ?? 1}-${o.pageTo ?? 9999}` : null;
  if (dryRun) {
    log(`[test mode] would print on "${job.printer}": ${JSON.stringify(o)}`);
    await new Promise((r) => setTimeout(r, 300));
    return;
  }
  if (process.platform === 'win32') {
    const { print } = await import('pdf-to-printer');
    await print(file, {
      printer: job.printer, copies: o.copies, monochrome: o.colorMode === 'bw',
      side: o.sides === 'double' ? 'duplexlong' : 'simplex', paperSize: PAPER[o.paperSize], ...(range ? { pages: range } : {}),
    });
  } else {
    const args = ['-d', job.printer, '-n', String(o.copies), '-o', `sides=${o.sides === 'double' ? 'two-sided-long-edge' : 'one-sided'}`, '-o', `media=${o.paperSize}`];
    if (o.colorMode === 'bw') args.push('-o', 'print-color-mode=monochrome');
    if (range) args.push('-o', `page-ranges=${range}`);
    await run('lp', [...args, file]);
  }
}

// ------------------------------------------------------------------ Config file
export class ConfigStore {
  constructor(file) { this.file = file; }
  load() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return {}; }
  }
  save(cfg) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  }
  update(patch) { const c = { ...this.load(), ...patch }; this.save(c); return c; }
}

export const defaultConfigPath = () => process.env.AGENT_CONFIG || path.join(os.homedir(), '.printsaas-agent.json');

export function normalizeServer(input) {
  let s = String(input ?? '').trim().replace(/\/+$/, '');
  if (!s) throw new Error('Enter the server address');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try { new URL(s); } catch { throw new Error('That server address does not look right'); }
  return s;
}

// ------------------------------------------------------------------ The agent
/**
 * status: 'unpaired' | 'connecting' | 'connected' | 'disconnected' (waiting to reconnect)
 * events: 'status' (state snapshot), 'log' (string), 'job' ({id, orderCode, status, error})
 */
export class AgentClient extends EventEmitter {
  constructor({ configPath = defaultConfigPath(), dryRun = false } = {}) {
    super();
    this.store = new ConfigStore(configPath);
    this.forceDryRun = dryRun; // PRINT_DRY_RUN=1 overrides the "test mode" setting
    this.status = 'unpaired';
    this.error = null;
    this.printers = [];
    this.recentJobs = [];
    this.ws = null;
    this.stopped = true;
    this.attempt = 0;
    this.lastActivity = 0;
    this.chain = Promise.resolve();
    this.inflight = new Set();
    const c = this.store.load();
    this.done = new Set(c.done ?? []);
  }

  get dryRun() { return this.forceDryRun || !!this.store.load().testMode; }
  get cfg() { return this.store.load(); }

  state() {
    const c = this.cfg;
    return {
      status: c.token ? this.status : 'unpaired', error: this.error, paired: !!c.token, server: c.server ?? null, shopName: c.shopName ?? null,
      printers: this.printers, recentJobs: this.recentJobs, testMode: this.dryRun, testModeForced: this.forceDryRun,
      autoStart: c.autoStart !== false, lang: c.lang ?? null,
    };
  }

  #setStatus(status, error = null) {
    this.status = status; this.error = error;
    this.emit('status', this.state());
  }
  #log(msg) { this.emit('log', msg); }

  async #api(pathname, { method = 'GET', json, auth = true } = {}) {
    const c = this.cfg;
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = `Bearer ${c.token}`;
    let res;
    try {
      res = await fetch(`${c.server}${pathname}`, { method, headers, body: json ? JSON.stringify(json) : undefined, signal: AbortSignal.timeout(90_000) });
    } catch {
      throw new Error('Could not reach the server. Check the internet connection and the server address');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || `Server error (${res.status})`), { status: res.status });
    return body;
  }

  /** Pairs this computer with a shop using the code from the dashboard, then connects. */
  async pair(serverInput, codeInput) {
    const server = normalizeServer(serverInput);
    const code = String(codeInput ?? '').trim().toUpperCase();
    if (!code) throw new Error('Enter the code from your dashboard');
    let res;
    try {
      res = await fetch(`${server}/api/agent/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }), signal: AbortSignal.timeout(90_000) });
    } catch {
      throw new Error('Could not reach the server. Check the internet connection and the server address');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Server error (${res.status})`);
    this.done = new Set();
    this.store.save({ ...this.cfg, server, token: body.token, shopName: body.shopName, done: [] });
    this.error = null;
    await this.start();
    return { shopName: body.shopName };
  }

  /** Forget the pairing on this computer. (Delete the computer in the dashboard to revoke it on the server.) */
  async unpair() {
    this.stop();
    const c = this.cfg; delete c.token; delete c.shopName;
    this.store.save(c);
    this.printers = [];
    this.#setStatus('unpaired');
  }

  async setOption(name, value) {
    if (!['autoStart', 'testMode', 'lang'].includes(name)) throw new Error('Unknown option');
    this.store.update({ [name]: value });
    this.emit('option', name, value);
    this.emit('status', this.state());
    if (name === 'testMode') await this.refreshPrinters();
  }

  async start() {
    this.stop();
    if (!this.cfg.token) return this.#setStatus('unpaired');
    this.stopped = false;
    this.attempt = 0;
    this.#connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.watchdog);
    clearInterval(this.printerTimer);
    const ws = this.ws; this.ws = null;
    if (ws) { ws.removeAllListeners('close'); ws.on('error', () => {}); try { ws.terminate(); } catch { /* ignore */ } }
  }

  #connect() {
    const c = this.cfg;
    this.#setStatus('connecting');
    const ws = new WebSocket(c.server.replace(/^http/i, 'ws') + '/ws/agent', { headers: { Authorization: `Bearer ${c.token}` }, handshakeTimeout: 60_000 });
    this.ws = ws;

    ws.on('open', async () => {
      this.attempt = 0; this.lastActivity = Date.now();
      this.#log(`Connected to ${c.server}`);
      this.#setStatus('connected');
      await this.refreshPrinters();
    });
    ws.on('message', (raw) => {
      this.lastActivity = Date.now();
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'job') this.#enqueue(msg.job);
      } catch { /* ignore malformed */ }
    });
    ws.on('ping', () => { this.lastActivity = Date.now(); });
    ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 401) {
        this.stop();
        const cfg = this.cfg; delete cfg.token; this.store.save(cfg);
        this.#setStatus('unpaired', 'This computer was removed from the dashboard. Pair it again with a new code.');
      }
    });
    ws.on('close', () => {
      if (this.stopped || this.ws !== ws) return;
      this.#scheduleReconnect();
    });
    ws.on('error', () => {});

    // The server pings every 30 s. If nothing arrives for 90 s (Wi-Fi dropped, laptop slept), reconnect.
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (this.ws === ws && this.status === 'connected' && Date.now() - this.lastActivity > 90_000) ws.terminate();
    }, 15_000);
    this.watchdog.unref?.();
    clearInterval(this.printerTimer);
    this.printerTimer = setInterval(() => this.refreshPrinters().catch(() => {}), 5 * 60_000);
    this.printerTimer.unref?.();
  }

  #scheduleReconnect() {
    const wait = Math.min(30_000, 1000 * 2 ** this.attempt++);
    this.#setStatus('disconnected');
    this.#log(`Disconnected. Reconnecting in ${Math.round(wait / 1000)}s`);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => !this.stopped && this.#connect(), wait);
  }

  #send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  /** Re-detect printers on this computer and tell the server (dashboard "Add printer" list). */
  async refreshPrinters() {
    this.printers = await detectPrinters({ dryRun: this.dryRun });
    this.#send({ type: 'printers', printers: this.printers.map((p) => ({ name: p.name, color: p.color, duplex: p.duplex, paperSizes: p.paperSizes })) });
    this.emit('status', this.state());
    return this.printers;
  }

  /** One click: add every real printer on this computer to the shop (plan limit applies). */
  async syncPrinters({ includeVirtual = false } = {}) {
    const all = await this.refreshPrinters();
    const list = all.filter((p) => includeVirtual || !p.virtual);
    const result = await this.#api('/api/agent/printers/sync', {
      method: 'POST',
      json: { printers: list.map((p) => ({ name: p.name, color: p.color, duplex: p.duplex, paperSizes: p.paperSizes })) },
    });
    return { ...result, found: all.length, virtualSkipped: all.length - list.length };
  }

  // ----- jobs -----
  #jobEvent(job, status, error = null) {
    const ev = { id: job.id, orderCode: job.orderCode, printer: job.printer, status, error, at: new Date().toISOString() };
    this.recentJobs = [ev, ...this.recentJobs.filter((j) => j.id !== job.id)].slice(0, 10);
    this.emit('job', ev);
    this.emit('status', this.state());
  }

  #enqueue(job) {
    if (this.inflight.has(job.id)) return;
    this.inflight.add(job.id);
    this.chain = this.chain.then(() => this.#runJob(job)).finally(() => this.inflight.delete(job.id));
  }

  async #assertPrinterInstalled(name) {
    if (this.dryRun) return;
    const list = await detectPrinters();
    if (!list.some((p) => p.name === name)) {
      throw new Error(`Printer "${name}" is not installed on this computer (installed here: ${list.map((p) => p.name).join(', ') || 'none'}). Install the printer, or turn on test mode`);
    }
  }

  async #runJob(job) {
    const tmp = path.join(os.tmpdir(), `printsaas-${job.id}.pdf`);
    try {
      if (this.done.has(job.id)) return this.#send({ type: 'job:status', jobId: job.id, status: 'done' }); // already printed
      this.#send({ type: 'job:status', jobId: job.id, status: 'printing' });
      this.#jobEvent(job, 'printing');
      this.#log(`Job ${job.orderCode}: downloading`);
      const c = this.cfg;
      const res = await fetch(`${c.server}/api/agent/jobs/${job.id}/file`, { headers: { Authorization: `Bearer ${c.token}` }, signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
      this.#log(`Job ${job.orderCode}: printing on "${job.printer}"`);
      await this.#assertPrinterInstalled(job.printer);
      await printPdf(tmp, job, { dryRun: this.dryRun, log: (m) => this.#log(m) });
      this.done.add(job.id);
      this.store.update({ done: [...this.done].slice(-200) });
      this.#send({ type: 'job:status', jobId: job.id, status: 'done' });
      this.#jobEvent(job, 'done');
      this.#log(`Job ${job.orderCode}: done`);
    } catch (e) {
      this.#log(`Job ${job.orderCode}: FAILED - ${e.message}`);
      this.#send({ type: 'job:status', jobId: job.id, status: 'failed', error: e.message });
      this.#jobEvent(job, 'failed', e.message);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
}
