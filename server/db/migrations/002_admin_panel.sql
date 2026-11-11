-- Admin panel: platform settings, private notes on shops, and an audit trail of admin actions.
-- Idempotent on purpose (safe to run on a database that already has some of it).
CREATE TABLE IF NOT EXISTS settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE shops ADD COLUMN IF NOT EXISTS admin_note text;

-- No foreign key on shop_id: the history must survive when a shop is deleted.
CREATE TABLE IF NOT EXISTS admin_audit (
  id          bigserial PRIMARY KEY,
  admin_id    uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
  admin_email text,
  action      text NOT NULL,
  shop_id     uuid,
  shop_name   text,
  details     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_audit_created_idx ON admin_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_shop_idx ON admin_audit (shop_id);
