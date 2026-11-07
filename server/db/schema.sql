-- PrintSaaS schema (PostgreSQL 13+). Multi-tenant: every tenant table carries shop_id.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPE shop_status      AS ENUM ('pending', 'active', 'suspended');
CREATE TYPE user_role        AS ENUM ('owner', 'staff');
CREATE TYPE color_mode       AS ENUM ('bw', 'color');
CREATE TYPE paper_size       AS ENUM ('A4', 'A3', 'A5', 'Legal', 'Letter');
CREATE TYPE print_sides      AS ENUM ('single', 'double');
CREATE TYPE payment_provider AS ENUM ('easypaisa', 'jazzcash', 'cash', 'mock');
CREATE TYPE payment_status   AS ENUM ('pending', 'paid', 'failed', 'refunded');
CREATE TYPE order_status     AS ENUM ('draft','awaiting_payment','paid','printing','completed','failed','cancelled','expired');
CREATE TYPE job_status       AS ENUM ('queued', 'sent', 'printing', 'done', 'failed');
CREATE TYPE printer_status   AS ENUM ('online', 'offline', 'paper_out', 'error');
CREATE TYPE sub_status       AS ENUM ('trialing', 'active', 'past_due', 'cancelled');

CREATE TABLE platform_admins (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plans (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL UNIQUE,
  price_monthly        numeric(12,2) NOT NULL DEFAULT 0,
  max_printers         int NOT NULL DEFAULT 1,
  max_orders_per_month int,                       -- NULL = unlimited
  is_active            boolean NOT NULL DEFAULT true
);

CREATE TABLE shops (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  phone       text,
  address     text,
  city        text,
  timezone    text NOT NULL DEFAULT 'Asia/Karachi',
  currency    char(3) NOT NULL DEFAULT 'PKR',
  status      shop_status NOT NULL DEFAULT 'pending',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id            uuid NOT NULL UNIQUE REFERENCES shops(id) ON DELETE CASCADE,
  plan_id            uuid NOT NULL REFERENCES plans(id),
  status             sub_status NOT NULL DEFAULT 'trialing',
  current_period_end timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shop_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id       uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role          user_role NOT NULL DEFAULT 'staff',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shop_users_shop_idx ON shop_users (shop_id);

CREATE TABLE agents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id            uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name               text NOT NULL,
  pairing_code       text UNIQUE,
  pairing_expires_at timestamptz,
  token_hash         text UNIQUE,
  detected_printers  jsonb NOT NULL DEFAULT '[]',
  last_seen_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agents_shop_idx ON agents (shop_id);

CREATE TABLE printers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  agent_id          uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  display_name      text NOT NULL,
  system_name       text NOT NULL,
  supports_color    boolean NOT NULL DEFAULT false,
  supports_duplex   boolean NOT NULL DEFAULT false,
  paper_sizes       paper_size[] NOT NULL DEFAULT '{A4}',
  status            printer_status NOT NULL DEFAULT 'offline',
  is_active         boolean NOT NULL DEFAULT true,
  status_updated_at timestamptz,
  UNIQUE (agent_id, system_name)
);
CREATE INDEX printers_shop_idx ON printers (shop_id);

CREATE TABLE pricing_rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id        uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  color_mode     color_mode NOT NULL,
  paper_size     paper_size NOT NULL,
  sides          print_sides NOT NULL,
  price_per_page numeric(10,2) NOT NULL CHECK (price_per_page >= 0),
  UNIQUE (shop_id, color_mode, paper_size, sides)
);

-- credentials_encrypted is AES-256-GCM ciphertext (see src/crypto.js); NULL for cash/mock.
CREATE TABLE shop_payment_accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id               uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  provider              payment_provider NOT NULL,
  credentials_encrypted bytea,
  credentials_hint      text,
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, provider)
);

CREATE TABLE orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id        uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  public_code    text NOT NULL,
  customer_phone text,
  status         order_status NOT NULL DEFAULT 'draft',
  color_mode     color_mode,
  paper_size     paper_size NOT NULL DEFAULT 'A4',
  sides          print_sides NOT NULL DEFAULT 'single',
  copies         int NOT NULL DEFAULT 1 CHECK (copies BETWEEN 1 AND 500),
  page_from      int,
  page_to        int,
  total_pages    int,
  printer_id     uuid REFERENCES printers(id) ON DELETE SET NULL,
  amount         numeric(12,2),
  payment_method payment_provider,
  payment_status payment_status NOT NULL DEFAULT 'pending',
  failure_reason text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  paid_at        timestamptz,
  expires_at     timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
  UNIQUE (shop_id, public_code)
);
CREATE INDEX orders_shop_idx ON orders (shop_id, created_at DESC);
CREATE INDEX orders_expiry_idx ON orders (status, expires_at);

CREATE TABLE order_files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  shop_id       uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  storage_path  text NOT NULL,
  original_name text NOT NULL,
  mime_type     text NOT NULL,
  size_bytes    bigint NOT NULL,
  page_count    int,
  delete_after  timestamptz,
  deleted_at    timestamptz
);

CREATE TABLE payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  shop_id         uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  provider        payment_provider NOT NULL,
  txn_ref         text UNIQUE,
  provider_txn_id text,
  amount          numeric(12,2) NOT NULL,
  status          payment_status NOT NULL DEFAULT 'pending',
  raw_callback    jsonb,
  verified_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payments_provider_txn_uniq ON payments (provider, provider_txn_id) WHERE provider_txn_id IS NOT NULL;
CREATE INDEX payments_order_idx ON payments (order_id);

CREATE TABLE print_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  shop_id     uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  printer_id  uuid NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
  status      job_status NOT NULL DEFAULT 'queued',
  attempts    int NOT NULL DEFAULT 0,
  error       text,
  queued_at   timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz
);
CREATE INDEX print_jobs_shop_idx ON print_jobs (shop_id, status);
CREATE INDEX print_jobs_printer_idx ON print_jobs (printer_id, status, queued_at);
