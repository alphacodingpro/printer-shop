import { q } from './db.js';
import { config } from './config.js';
import { HttpError } from './errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Platform settings the admin can change in the panel. Environment variables only provide the first defaults. */
export const defaults = () => ({
  defaultTrialDays: config.trialDays,
  requireApproval: config.requireApproval,
  signupsEnabled: true,
  defaultPlanId: null, // null = the cheapest active plan
  contactInfo: '',     // shown to shops when their trial ends, e.g. a WhatsApp number
});

export async function getSettings(db = { query: q }) {
  const r = await db.query('SELECT key, value FROM settings');
  return { ...defaults(), ...Object.fromEntries(r.rows.map((x) => [x.key, x.value])) };
}

/** Validates a partial update and returns only the keys to store. */
export async function validateSettings(patch) {
  const out = {};
  if ('defaultTrialDays' in patch) {
    const n = Number(patch.defaultTrialDays);
    if (!Number.isInteger(n) || n < 1 || n > 365) throw new HttpError(400, 'Trial length must be between 1 and 365 days');
    out.defaultTrialDays = n;
  }
  for (const k of ['requireApproval', 'signupsEnabled']) {
    if (k in patch) {
      if (typeof patch[k] !== 'boolean') throw new HttpError(400, `Invalid value for ${k}`);
      out[k] = patch[k];
    }
  }
  if ('defaultPlanId' in patch) {
    if (patch.defaultPlanId == null || patch.defaultPlanId === '') out.defaultPlanId = null;
    else {
      if (!UUID_RE.test(String(patch.defaultPlanId))) throw new HttpError(400, 'Choose a valid plan');
      const r = await q('SELECT 1 FROM plans WHERE id = $1 AND is_active', [patch.defaultPlanId]);
      if (!r.rows.length) throw new HttpError(400, 'That plan does not exist or is turned off');
      out.defaultPlanId = patch.defaultPlanId;
    }
  }
  if ('contactInfo' in patch) out.contactInfo = String(patch.contactInfo ?? '').trim().slice(0, 300);
  return out;
}

export async function saveSettings(db, values) {
  for (const [key, value] of Object.entries(values)) {
    await db.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)]
    );
  }
}
