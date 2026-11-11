import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, q, tx, registerEnumArrayParsers } from './db.js';
import { config } from './config.js';
import { hashPassword } from './auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * db/schema.sql creates a brand-new database. Everything added later lives in db/migrations/NNN_name.sql
 * and is applied once, in order, to every database (new or already deployed), tracked in schema_migrations.
 */
export async function migrate() {
  const exists = await q(`SELECT to_regclass('public.shops') AS t`);
  if (!exists.rows[0].t) {
    const sql = fs.readFileSync(path.join(here, '..', 'db', 'schema.sql'), 'utf8');
    await q(sql);
    console.log('Database schema created');
  }

  await q(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const dir = path.join(here, '..', 'db', 'migrations');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort() : [];
  for (const file of files) {
    const done = await q('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
    if (done.rows.length) continue;
    await tx(async (c) => {
      await c.query(fs.readFileSync(path.join(dir, file), 'utf8'));
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    console.log(`Applied migration ${file}`);
  }

  const plans = await q('SELECT count(*)::int AS n FROM plans');
  if (plans.rows[0].n === 0) {
    // Placeholder pricing: edit from the admin panel.
    await q(
      `INSERT INTO plans (name, price_monthly, max_printers, max_orders_per_month) VALUES
       ('Basic', 1500, 1, 1000), ('Pro', 4000, 10, NULL)`
    );
  }

  if (config.adminEmail && config.adminPassword) {
    const a = await q('SELECT 1 FROM platform_admins WHERE email = $1', [config.adminEmail.toLowerCase()]);
    if (!a.rows.length) {
      await q('INSERT INTO platform_admins (email, password_hash) VALUES ($1, $2)', [
        config.adminEmail.toLowerCase(),
        await hashPassword(config.adminPassword),
      ]);
      console.log(`Super admin created: ${config.adminEmail}`);
    }
  }
  await registerEnumArrayParsers();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate()
    .then(() => pool.end())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
