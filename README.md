# PrintSaaS

A multi-shop SaaS for print shops. A customer scans the shop's **QR code**, uploads a file, chooses **colour or black & white** (plus copies, sides, paper size, page range), pays with **JazzCash, Easypaisa or cash**, and the job prints automatically on the shop's printer. Each shop manages its own printers, prices and payment accounts from a dashboard. You (the platform owner) manage shops and plans from an admin panel.

**Urdu mein khulasa:** customer QR scan karta hai, file upload karta hai, color ya B&W chunta hai, JazzCash/Easypaisa/cash se payment karta hai, aur payment confirm hote hi shop ke printer par print shuru ho jata hai. Har shop ke apne printers, apne rates aur apna payment account hota hai. Setup ke liye neeche "Quick start" dekhein; shop ke computer par chalne wale program ke liye `agent/README.md`.

## How it fits together

```
 Customer phone                 Cloud (this repo: /server)                 Shop computer (/agent)
 ┌────────────┐  HTTPS   ┌──────────────────────────────────┐   WebSocket   ┌───────────────┐
 │ /s/<shop>  │─────────▶│ Express API + PostgreSQL         │◀─────────────▶│ Print Agent   │──▶ printers
 │ upload,pay │          │ file storage, job queue, hub     │  (outgoing    │ (Node.js)     │
 └────────────┘          │ payment webhooks (verified)      │   only)       └───────────────┘
 Shop owner  ──/dashboard │ dashboard + admin panel          │
 You         ──/admin     └──────────────────────────────────┘
```

* **Nothing prints before payment is verified on the server.** The browser's "success" page is never trusted.
* The agent only makes *outgoing* connections, so shops need no router or firewall changes.
* Multi-tenant: one database, every table carries `shop_id`; each shop sees only its own data.

## What is included

| Area | Features |
|---|---|
| Customer page (`/s/<shop>`) | Mobile-first, English/Urdu (RTL), file upload (PDF, JPG/PNG, Word, PowerPoint, Excel), live price, page ranges |
| Printing | Multiple printers per shop, colour/B&W routing, duplex, paper size, load balancing, retries, reprint |
| Payments | Per-shop JazzCash and Easypaisa credentials (AES-256-GCM encrypted), cash at counter with "Cash received" button |
| Shop dashboard (`/dashboard`) | Live orders, printers & computers, price list, payment setup, QR poster, staff accounts |
| Admin (`/admin`) | Approve/suspend shops, plans, subscription status and paid-until date |
| Privacy | Customer files deleted ~2 minutes after printing, or when an order expires/cancels |

## Quick start (local)

Needs Node 18+ and PostgreSQL 13+ (or Docker).

```bash
# Option A: Docker (database + app)
docker compose up --build
# open http://localhost:3000

# Option B: without Docker
cd server
cp .env.example .env          # then edit it
npm install
npm start                     # creates tables, plans and the admin account on first start
```

Then:

1. Open `/login`, **create your shop**.
2. Dashboard → **Printers → Add computer**, pair the agent (see `agent/README.md`). For a first try without a printer: `PRINT_DRY_RUN=1 node agent.js`.
3. Add your printers, check **Prices**, and open **Shop & QR** to print the poster.
4. Scan the QR (or open the shop link), upload a file, and pick **Test payment** (available outside production) or **Pay at the counter**.

Admin panel: `/admin` (email and password from `ADMIN_EMAIL` / `ADMIN_PASSWORD`; change them after the first login).

## Configuration (`server/.env`)

| Variable | Notes |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string. Set `DATABASE_SSL=true` for hosts that require SSL |
| `JWT_SECRET` | 32+ random characters |
| `ENCRYPTION_KEY` | **Exactly 64 hex characters.** Encrypts shops' payment keys. **Back it up**: if it is lost, saved gateway keys cannot be recovered |
| `PUBLIC_URL` | Public HTTPS address of your server. Used in QR codes and payment callbacks |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Super admin created on first start |
| `REQUIRE_SHOP_APPROVAL` | `true` = new shops stay "pending" until you approve them in `/admin` |
| `TRIAL_DAYS` | Free trial length for new shops (default 14) |
| `MAX_FILE_MB`, `MAX_PAGES` | Upload limits (default 25 MB, 300 pages) |
| `STORAGE_DIR` | Where uploaded files wait for printing. Must be persistent in production |
| `SOFFICE_PATH` | LibreOffice binary for Word/PowerPoint/Excel conversion. Without it only PDF and photos are accepted |
| `ENABLE_MOCK_PAYMENTS` | Fake payment page for testing. **Always disabled when `NODE_ENV=production`** |

Generate secrets: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (use for `ENCRYPTION_KEY`; use 48 bytes for `JWT_SECRET`).

## Payment gateways: read before going live

Each shop signs up for its **own** JazzCash and/or Easypaisa merchant account (approval takes time; ask them early) and enters the keys in **Dashboard → Payments**. Money goes straight to the shop.

* **JazzCash** (hosted checkout): the return is verified with the HMAC-SHA256 secure hash, the reference and the exact amount.
* **Easypaisa** (hosted checkout): the browser return is *not* trusted. The server asks Easypaisa's inquiry API whether the order is `PAID`, and fails closed if that call does not confirm it.

**Important:** both adapters (`server/src/providers/`) were written from the gateways' public integration guides and are covered by automated tests only for *our* side (signing, verification, forgery rejection). They have **not** been run against live JazzCash/Easypaisa sandboxes, whose field names and versions change between merchant kits. Before you enable them for real customers: put the shop in **Sandbox mode**, run a few test payments, compare the fields with the guide your gateway gave you, and then fix the adapter if anything differs. Both files are short and commented. Cash and the test gateway work without any of this.

## Deploy

**Render** (matches how you host other apps): push to GitHub, then *New → Blueprint* and pick the repo (`render.yaml`). Set `ENCRYPTION_KEY`, `PUBLIC_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` in the Environment tab. A persistent disk is needed for `STORAGE_DIR`, which requires a paid instance. Use HTTPS only (Render does this for you).

**Any VPS:** `docker compose up -d --build` behind nginx/Caddy for HTTPS, with `NODE_ENV=production` and real secrets.

Push to GitHub:

```bash
cd print-saas
git init -b main
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

`.gitignore` already excludes `.env`, `node_modules` and uploaded files. Never commit real keys.

## Tests

```bash
cd server
export TEST_DATABASE_URL=postgres://user:pass@localhost:5432/printsaas_test   # a THROWAWAY database: tests wipe it
npm test
```

16 tests: signup/login, plan limits, real agent process pairing and printing (dry run), colour routing, cash flow, JazzCash signature checks (forged, tampered, wrong amount), amount-change fraud, tenant isolation, upload validation, file deletion, and a render check of every web page.

## Known limits (v1)

* **Not tested on real printers or on Windows.** Printing is verified end-to-end in dry-run mode; the Windows path uses `pdf-to-printer` (SumatraPDF). Test with your printers and adjust `agent/agent.js` if a driver needs special options.
* Subscription billing is manual: you set a shop's plan and paid-until date in `/admin`. There is no automatic charging.
* No email verification or password reset yet. Shop owners must tell you to reset a password.
* One server instance: the agent hub is in memory. Running several instances needs a shared pub/sub layer (e.g. Redis).
* Uploaded files live on local disk (`STORAGE_DIR`).
* If a customer pays twice for one order (two payment tabs), both payments appear under Payments in the database; the shop must refund the extra one manually.
* Prices are per page and the same for every page; there is no per-job minimum charge.

## Project layout

```
server/   Express API, PostgreSQL schema (db/schema.sql), web pages (public/), tests (test/)
agent/    Print Agent for the shop computer
render.yaml, docker-compose.yml
```
