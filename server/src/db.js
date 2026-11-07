import pg from 'pg';
import { config } from './config.js';

// numeric -> JS number (amounts are small, 2 decimals)
pg.types.setTypeParser(1700, (v) => parseFloat(v));
pg.types.setTypeParser(20, (v) => parseInt(v, 10)); // bigint

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

export const q = (text, params) => pool.query(text, params);

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * node-postgres only knows built-in array types. Arrays of our own enums (e.g. paper_size[])
 * would arrive as the raw string "{A4,A3}", so we register a parser once the types exist.
 */
export async function registerEnumArrayParsers() {
  const r = await pool.query(`SELECT typarray FROM pg_type WHERE typname = 'paper_size' AND typarray <> 0`);
  for (const row of r.rows) {
    pg.types.setTypeParser(row.typarray, (v) => (v === '{}' ? [] : v.slice(1, -1).split(',')));
  }
}
