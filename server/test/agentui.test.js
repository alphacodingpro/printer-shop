// The tray app window (agent/app/ui) rendered in jsdom against a fake window.agent bridge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const ui = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'agent', 'app', 'ui');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;

const base = { status: 'unpaired', error: null, paired: false, server: null, shopName: null, printers: [], recentJobs: [], testMode: false, testModeForced: false, autoStart: true, lang: 'en', defaultServer: 'https://printsaas.onrender.com' };

async function open(initial = {}, impl = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(ui, 'index.html'), 'utf8'), { url: 'file:///agent/ui/index.html', pretendToBeVisual: true });
  const w = dom.window;
  let state = { ...base, ...initial };
  const subs = []; const calls = [];
  w.agent = {
    getState: async () => structuredClone(state),
    onState: (cb) => subs.push(cb),
    pair: async (...a) => { calls.push(['pair', ...a]); return impl.pair ? impl.pair(...a) : { ok: true, sync: null }; },
    fetchPrinters: async (o) => { calls.push(['fetch', o]); return impl.fetch ? impl.fetch(o) : { ok: true, result: { added: [], existing: [], skipped: [], found: 0, virtualSkipped: 0 } }; },
    setOption: async (...a) => { calls.push(['option', ...a]); return { ok: true }; },
    unpair: async () => { calls.push(['unpair']); return { ok: true }; },
    openDashboard: async () => { calls.push(['dashboard']); },
  };
  const define = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  define('window', w); define('document', w.document); define('navigator', w.navigator); define('confirm', () => true);
  const errors = []; w.addEventListener('error', (e) => errors.push(e.error || e.message));
  await import(pathToFileURL(path.join(ui, 'ui.js')).href + `?run=${++n}`);
  await sleep(50);
  return {
    w, doc: w.document, calls, errors,
    text: () => w.document.body.textContent,
    push: async (patch) => { state = { ...state, ...patch }; subs.forEach((cb) => cb(structuredClone(state))); await sleep(30); },
    button: (label) => [...w.document.querySelectorAll('button')].find((b) => b.textContent.includes(label)),
  };
}

test('not set up: shows the connect screen with the default server and asks for the code', async () => {
  const p = await open();
  assert.match(p.text(), /Not set up yet/);
  assert.match(p.text(), /Connect this computer/);
  assert.match(p.text(), /printsaas\.onrender\.com/);
  p.button('Connect').click();
  await sleep(30);
  assert.match(p.text(), /Enter the code from your dashboard/);
  assert.equal(p.calls.filter((c) => c[0] === 'pair').length, 0, 'does not call the server without a code');
  assert.deepEqual(p.errors, []);
  assert.doesNotMatch(p.text(), /(null|undefined|false)/, 'no stray null/false/undefined text');
});

test('pairing: wrong code shows the error, the right code switches to the connected screen', async () => {
  let attempt = 0;
  const p = await open({}, { pair: async () => (++attempt === 1 ? { ok: false, error: 'This code is wrong or has expired. Create a new one in the dashboard' } : { ok: true, sync: { found: 2, added: ['A'], existing: [], skipped: ['B'], limit: 1, virtualSkipped: 1 } }) });
  const input = p.doc.getElementById('code');
  input.value = 'abcd-2345'; input.dispatchEvent(new p.w.Event('input'));
  p.button('Connect').click();
  await sleep(50);
  assert.deepEqual(p.calls[0], ['pair', 'https://printsaas.onrender.com', 'ABCD-2345'], 'code is upper-cased');
  assert.match(p.text(), /wrong or has expired/);

  p.button('Connect').click();
  await sleep(30);
  await p.push({ paired: true, status: 'connected', shopName: 'Ultra Prints', printers: [{ name: 'HP LaserJet', color: false, duplex: true, isDefault: true, virtual: false }] });
  assert.match(p.text(), /Connected to Ultra Prints/);
  assert.match(p.text(), /Fetch my printers/);
  assert.match(p.text(), /Added to your shop: 1/);
  assert.match(p.text(), /1 not added because your plan allows 1 printer/);
  assert.match(p.text(), /1 virtual printer/);
});

test('connected: lists printers, one click fetches them, virtual printers need a separate click', async () => {
  const p = await open({ paired: true, status: 'connected', shopName: 'Ultra', server: 'https://x.test',
    printers: [
      { name: 'Epson L3250', color: true, duplex: false, isDefault: true, virtual: false },
      { name: 'HP LaserJet', color: false, duplex: true, isDefault: false, virtual: false },
      { name: 'Microsoft Print to PDF', color: false, duplex: false, isDefault: false, virtual: true },
    ] }, { fetch: async (o) => ({ ok: true, result: { found: 3, added: o.includeVirtual ? ['Microsoft Print to PDF'] : ['Epson L3250', 'HP LaserJet'], existing: [], skipped: [], limit: 10, virtualSkipped: o.includeVirtual ? 0 : 1 } }) });
  const t = p.text();
  assert.match(t, /Epson L3250/); assert.match(t, /Colour/); assert.match(t, /2-sided/); assert.match(t, /virtual/);
  p.button('Fetch my printers').click();
  await sleep(50);
  assert.deepEqual(p.calls.at(-1), ['fetch', { includeVirtual: false }]);
  assert.match(p.text(), /Found 3 printer\(s\)\. Added to your shop: 2/);
  p.button('Add virtual printers too').click();
  await sleep(50);
  assert.deepEqual(p.calls.at(-1), ['fetch', { includeVirtual: true }]);
});

test('status follows the connection: connecting, disconnected, back to connected', async () => {
  const p = await open({ paired: true, status: 'connecting', shopName: 'Ultra' });
  assert.match(p.text(), /Connecting…/);
  assert.ok(p.doc.querySelector('.status.connecting'));
  assert.equal(p.button('Fetch my printers').disabled, true, 'cannot fetch while offline');
  await p.push({ status: 'disconnected' });
  assert.match(p.text(), /Not connected/);
  assert.match(p.text(), /Trying again automatically/);
  assert.ok(p.doc.querySelector('.status.disconnected'));
  await p.push({ status: 'connected' });
  assert.match(p.text(), /Connected to Ultra/);
  assert.ok(p.doc.querySelector('.status.connected'));
  assert.equal(p.button('Fetch my printers').disabled, false);
});

test('recent orders show success and failure; printer names cannot inject HTML', async () => {
  const p = await open({ paired: true, status: 'connected', shopName: 'Ultra',
    printers: [{ name: '<img src=x onerror=alert(1)>', color: false, duplex: false, isDefault: false, virtual: false }],
    recentJobs: [{ id: '1', orderCode: '123456', printer: 'HP', status: 'done' }, { id: '2', orderCode: '654321', printer: 'HP', status: 'failed', error: 'Printer "HP" is not installed on this computer' }] });
  assert.match(p.text(), /#123456/); assert.match(p.text(), /Done/);
  assert.match(p.text(), /#654321/); assert.match(p.text(), /Failed/); assert.match(p.text(), /not installed on this computer/);
  assert.equal(p.doc.querySelector('img'), null, 'no element was created from the printer name');
  assert.match(p.text(), /<img src=x/);
});

test('settings: auto-start, test mode, Urdu, dashboard and disconnect all reach the main process', async () => {
  const p = await open({ paired: true, status: 'connected', shopName: 'Ultra', server: 'https://x.test' });
  const [auto, test_] = [...p.doc.querySelectorAll('input[type=checkbox]')];
  assert.equal(auto.checked, true);
  auto.checked = false; auto.dispatchEvent(new p.w.Event('change'));
  test_.checked = true; test_.dispatchEvent(new p.w.Event('change'));
  assert.deepEqual(p.calls.filter((c) => c[0] === 'option'), [['option', 'autoStart', false], ['option', 'testMode', true]]);

  p.button('Open dashboard').click();
  assert.equal(p.calls.at(-1)[0], 'dashboard');

  p.button('اردو').click();
  await sleep(30);
  assert.equal(p.doc.documentElement.dir, 'rtl');
  assert.match(p.text(), /جڑا ہوا ہے/);
  assert.deepEqual(p.calls.at(-1), ['option', 'lang', 'ur']);

  p.button('اس کمپیوٹر کو الگ کریں').click();
  assert.equal(p.calls.at(-1)[0], 'unpair');
});

test('a computer removed from the dashboard shows the reason on the connect screen', async () => {
  const p = await open({ status: 'unpaired', paired: false, error: 'This computer was removed from the dashboard. Pair it again with a new code.' });
  assert.match(p.text(), /removed from the dashboard/);
  assert.match(p.text(), /Connect this computer/);
});

test('forced test mode (PRINT_DRY_RUN) cannot be switched off from the window', async () => {
  const p = await open({ paired: true, status: 'connected', shopName: 'Ultra', testMode: true, testModeForced: true });
  const box = [...p.doc.querySelectorAll('input[type=checkbox]')][1];
  assert.equal(box.disabled, true);
  assert.equal(box.checked, true);
});
