#!/usr/bin/env node
// PrintSaaS Print Agent (command line).  The tray app (npm run gui / installer) uses the same core.
//   node agent.js pair ABCD-EFGH --server https://your-app.example.com   (once)
//   node agent.js                                                        (run)
//   node agent.js printers                                               (list printers on this PC)
//   node agent.js sync                                                   (add all real printers to your shop)
//
// Env: AGENT_CONFIG=<path to config json>, PRINT_DRY_RUN=1 (log instead of printing)
import { AgentClient, detectPrinters, defaultConfigPath } from './src/core.js';

const DRY_RUN = process.env.PRINT_DRY_RUN === '1';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const client = new AgentClient({ configPath: defaultConfigPath(), dryRun: DRY_RUN });
client.on('log', (m) => log(m));

const [, , cmd, ...rest] = process.argv;

if (cmd === 'pair') {
  const code = rest.find((a) => !a.startsWith('--'));
  const server = rest.includes('--server') ? rest[rest.indexOf('--server') + 1] : client.cfg.server;
  if (!code || !server) {
    console.error('Usage: node agent.js pair ABCD-EFGH --server https://your-app.example.com');
    process.exit(1);
  }
  try {
    const r = await client.pair(server, code);
    client.stop();
    console.log(`Paired with "${r.shopName}". Now run: node agent.js`);
    process.exit(0);
  } catch (e) {
    console.error('Pairing failed:', e.message);
    process.exit(1);
  }
}

if (cmd === 'printers') {
  const list = await detectPrinters({ dryRun: DRY_RUN });
  console.log(list.length
    ? list.map((p) => `- ${p.name}${p.isDefault ? ' (default)' : ''}  [${p.color ? 'colour' : 'B&W'}, ${p.duplex ? '2-sided' : '1-sided'}, ${p.paperSizes.join('/')}]${p.virtual ? '  (virtual)' : ''}`).join('\n')
    : 'No printers found');
  process.exit(0);
}

if (cmd === 'sync') {
  if (!client.cfg.token) { console.error('Not paired yet. Run: node agent.js pair <CODE> --server <URL>'); process.exit(1); }
  try {
    const r = await client.syncPrinters({ includeVirtual: rest.includes('--include-virtual') });
    console.log(`Found ${r.found} printer(s). Added: ${r.added.length}, already in your shop: ${r.existing.length}, not added (plan limit): ${r.skipped.length}, virtual skipped: ${r.virtualSkipped}.`);
    process.exit(0);
  } catch (e) { console.error('Could not add printers:', e.message); process.exit(1); }
}

// ---------- Main loop ----------
if (!client.cfg.token) {
  console.error('Not paired yet. Run: node agent.js pair <CODE> --server <URL>');
  process.exit(1);
}
client.on('status', (s) => {
  if (s.status === 'unpaired' && s.error) { console.error(s.error); process.exit(1); }
});
await client.start();
const found = await detectPrinters({ dryRun: DRY_RUN });
if (DRY_RUN) log('DRY RUN: nothing will really print');
else if (!found.length) log('No printers are installed on this computer. To test without a printer, run: PRINT_DRY_RUN=1 node agent.js');
