# PrintSaaS Agent

The program for the **shop computer that is connected to the printers**. It sits in the taskbar (Windows) or menu bar (macOS), shows whether the computer is connected, starts by itself when the computer starts, and prints paid orders on the right printer with the right settings.

| Tray icon | Meaning |
|---|---|
| 🟢 green dot | Connected. Paid orders will print here |
| 🟡 amber dot | Connecting… |
| 🔴 red dot | Not connected. It retries by itself (check the internet) |
| ⚪ grey dot | Not set up yet. Open the app and type the code |

Click the icon to open the window. Right-click for the menu (Open, Fetch my printers, Open dashboard, Start with this computer, Quit). Closing the window does **not** stop the agent; only **Quit** does.

> Windows 11 hides new tray icons behind the **^** arrow. Drag the printer icon out of that menu onto the taskbar so it is always visible.

## Install on Windows (shop computer)

1. Get the installer **`PrintSaaS-Agent-Setup.exe`** (see "Build the installer" below, it takes a few clicks on GitHub).
2. Double-click it. It installs for the current user (no administrator password) and starts the app.
   * Windows may show a blue **"Windows protected your PC"** screen because the installer is not code-signed. Click **More info → Run anyway**.
3. Make sure the printers work from Windows first (print a test page).
4. In your dashboard open **Printers → Add computer** and give the computer a name. You get a code like `AB3K-7XQM`.
5. In the PrintSaaS Agent window type the code and press **Connect**. That is all: the computer connects and **every real printer on it is added to your shop automatically**, with colour / two-sided / paper-size detected.
6. Check the printers in the dashboard (Printers tab) and set your prices.

From now on the agent starts with Windows and reconnects by itself after the internet or the computer comes back. Nothing to open or click.

**One click for new printers:** installed another printer later? Open the window and press **Fetch my printers**.
Virtual printers (Microsoft Print to PDF, Fax, OneNote, XPS…) are not added automatically so they do not use up your plan's printer limit; press **Add virtual printers too** if you want them for testing.

If your plan allows fewer printers than the computer has, the window tells you how many were not added.

## macOS

Needs Node.js 18+.
```bash
cd agent
npm install
npm run gui
```
Same screens as on Windows (menu bar icon instead of the taskbar). To start it at login, open the window once and keep **Start automatically** ticked (this works for the installed `.dmg` version; from `npm run gui` start it yourself). Printing uses CUPS (`lp`), so printers must be added in System Settings → Printers & Scanners. A `.dmg` can be built by the same GitHub workflow (unsigned: right-click → Open the first time).

## Testing without a printer

Tick **Test mode (do not really print)** in the window (or run with `PRINT_DRY_RUN=1`). The app then shows two pretend printers (`Test-Color`, `Test-BW`), and orders finish as if printed. Turn it off before real use.

## Build the installer

Easiest, no Windows computer needed: push this repo to GitHub, open the **Actions** tab → **Build PrintSaaS Agent** → **Run workflow**. After a few minutes download `PrintSaaS-Agent-Windows` from the finished run (it contains the `.exe`). Pushing a tag such as `agent-v1.1.0` also publishes the installers under **Releases**, which gives a permanent link to put in `AGENT_DOWNLOAD_URL` so your dashboard shows a "Download PrintSaaS Agent" button.

On a Windows PC with Node.js: `cd agent && npm ci && npm run dist:win`; the installer appears in `agent/dist/`.

## Settings and data

* Settings and the pairing token are stored in `%APPDATA%\PrintSaaS Agent\agent.json` (macOS: `~/Library/Application Support/PrintSaaS Agent/`). Uninstalling does not delete it.
* **Disconnect this computer** forgets the pairing on this PC. To revoke a computer on the server, delete it in the dashboard (Printers → Computers). A removed computer shows "removed from the dashboard" and asks for a new code.
* The server address is pre-filled (set in `agent/package.json` → `printsaas.defaultServer`). Press "Change server" in the window to point it elsewhere.
* The agent only makes **outgoing** connections, so no router or firewall changes are needed.
* The last 200 printed job IDs are remembered, so a reconnect never prints the same job twice. If the internet drops, jobs wait on the server and print when the agent is back.

## Command line (optional)

The same engine works without the window, for servers or testing:
```bash
cd agent && npm install
node agent.js pair ABCD-EFGH --server https://your-app.example.com
node agent.js printers          # list printers with colour/duplex detection
node agent.js sync              # add all real printers to your shop
node agent.js                   # run (PRINT_DRY_RUN=1 for test mode)
```

## Known limits

* Verified: connecting, status changes, automatic reconnect, one-click printer sync with the plan limit, order printing in test mode, the tray window in English and Urdu (automated tests plus the real Electron app on a virtual screen).
* **Not verified on a real Windows PC or a real printer.** Colour / two-sided / paper-size detection on Windows uses `Win32_Printer` capabilities, which some drivers report inaccurately. If a printer is detected wrongly, correct it in the dashboard (Printers → Edit). Printing on Windows uses SumatraPDF through `pdf-to-printer`.
* The installer is not code-signed (Windows SmartScreen warning, see above). There is no automatic update yet: install the newer installer over the old one.
