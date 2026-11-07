# PrintSaaS Print Agent

A small program that runs on the **shop computer that is connected to the printers**. It keeps a secure connection to your PrintSaaS server, receives jobs only after payment is confirmed, downloads the PDF, and prints it with the right colour/duplex/paper/copies settings.

## Windows (typical print shop)

1. Install **Node.js 18+ (LTS)** from nodejs.org on the shop computer.
2. Copy this `agent` folder to the PC (e.g. `C:\PrintSaaS\agent`), open Command Prompt there and run `npm install`.
3. In the dashboard open **Printers > Add computer**, give it a name, and note the pairing code.
4. Pair once (code is valid for 15 minutes):
   ```
   node agent.js pair ABCD-EFGH --server https://your-app.example.com
   ```
5. See your printers: `node agent.js printers`. Printer names must match what Windows shows.
6. Run it: double-click `start-agent.bat` (restarts itself if it stops). Put a shortcut to it in
   `shell:startup` so it starts when the PC turns on.
7. Back in the dashboard, add each printer (colour? both sides? paper sizes) and set your prices.

Printing on Windows uses the bundled SumatraPDF through the `pdf-to-printer` package, so no Adobe Reader is needed.

## Linux / macOS

Uses CUPS (`lp`). Same steps; printer names come from `lpstat -e`.

## Testing without a printer

`PRINT_DRY_RUN=1 node agent.js` pretends to print (logs only).

## Good to know

* The agent only makes **outgoing** connections, so no router/port changes are needed.
* The pairing token is stored in `~/.printsaas-agent.json` (override with `AGENT_CONFIG`). Delete the computer in the dashboard to revoke it.
* The agent remembers the last 200 printed job IDs, so a reconnect never prints the same job twice.
* If the internet drops, jobs wait on the server and are sent when the agent reconnects.
