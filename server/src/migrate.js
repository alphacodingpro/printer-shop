import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, q, registerEnumArrayParsers } from './db.js';
import { config } from './config.js';
import { hashPassword } from './auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function migrate() {
  const exists = await q(`SELECT to_regclass('public.shops') AS t`);
  if (!exists.rows[0].t) {
    const sql = fs.readFileSync(path.join(here, '..', 'db', 'schema.sql'), 'utf8');
    await q(sql);
    console.log('Database schema created');
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
