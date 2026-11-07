import { q } from './db.js';
import { removeFile } from './storage.js';
import { dispatchJob } from './hub.js';

/** Expires stale orders, deletes customer files whose time has come, clears old pairing codes. */
export async function runCleanup() {
  const expired = await q(
    `UPDATE orders o SET status = 'expired'
      WHERE o.status IN ('draft', 'awaiting_payment') AND o.expires_at < now()
        AND NOT EXISTS (
          SELECT 1 FROM payments p
           WHERE p.order_id = o.id AND p.status = 'pending'
             AND p.provider IN ('easypaisa', 'jazzcash') AND p.created_at > now() - interval '2 hours')
      RETURNING o.id`
  );
  if (expired.rows.length) {
    await q(`UPDATE order_files SET delete_after = now() WHERE order_id = ANY($1::uuid[]) AND delete_after IS NULL`, [
      expired.rows.map((r) => r.id),
    ]);
  }

  const due = await q(`SELECT id, storage_path FROM order_files WHERE deleted_at IS NULL AND delete_after <= now()`);
  for (const f of due.rows) {
    await removeFile(f.storage_path);
    await q('UPDATE order_files SET deleted_at = now() WHERE id = $1', [f.id]);
  }

  // A job stuck in 'printing' (agent crashed mid-print) goes back to the queue.
  const stuck = await q(
    `UPDATE print_jobs SET status = 'queued' WHERE status = 'printing' AND started_at < now() - interval '10 minutes' RETURNING id`
  );
  for (const j of stuck.rows) await dispatchJob(j.id);

  await q(`UPDATE agents SET pairing_code = NULL, pairing_expires_at = NULL WHERE pairing_expires_at < now()`);
  return { expired: expired.rows.length, filesDeleted: due.rows.length };
}
