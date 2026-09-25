-- Satpuda Core PostgreSQL Schema
-- Multi-tenant pharmacy POS: stores, inventory, sales, purchases, sync

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Platform / Auth ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS admins (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stores (
  id              SERIAL PRIMARY KEY,
  store_id        TEXT NOT NULL UNIQUE,          -- e.g. store_roshan
  store_key       TEXT NOT NULL UNIQUE,          -- e.g. Store_Roshan
  store_name      TEXT NOT NULL,
  app_mode        TEXT NOT NULL DEFAULT 'online', -- online | offline
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  android_key     TEXT UNIQUE,                   -- SC-XXXXXXXX pairing key
  device_role     TEXT DEFAULT 'pc',
  notes           TEXT,
  activation_date DATE,                          -- first online activation (YYYY-MM-DD)
  expiry_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
  expiry_date     DATE,                          -- access ends on/after this day when enabled
  apply_expiry_check BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Existing DBs created before license columns
ALTER TABLE stores ADD COLUMN IF NOT EXISTS activation_date DATE;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS expiry_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS expiry_date DATE;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS apply_expiry_check BOOLEAN NOT NULL DEFAULT TRUE;

-- Voice assistant, per store, switched from the admin panel. OFF unless the
-- owner turns it on: a shop that has never been touched shows no voice button.
-- voice_tier caps what the shop PC runs: 'auto' (the PC decides from its own
-- hardware), '1' wake word + speaker check, '2' + small local AI,
-- '3' + large AI and better hearing. Not part of the signed licence blob: a
-- missing value anywhere on the desktop means OFF.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS voice_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS voice_tier TEXT NOT NULL DEFAULT 'auto';

CREATE INDEX IF NOT EXISTS idx_stores_android_key ON stores(android_key) WHERE android_key IS NOT NULL;

-- Self-service trial: this store was created by the installer through
-- /api/provision/trial, not by an administrator in the panel. Strangers can
-- reach that endpoint, so the flag exists to make every such store obvious in
-- the admin panel and killable in one click.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS provisioned_trial BOOLEAN NOT NULL DEFAULT FALSE;

-- One row per granted trial. This table -- never the stores table -- is what
-- the rate limits are counted from, and it is what the admin panel lists so the
-- owner can see who signed up, from which computer and which address.
CREATE TABLE IF NOT EXISTS store_provisions (
  id             SERIAL PRIMARY KEY,
  store_pk       INT REFERENCES stores(id) ON DELETE SET NULL,
  device_id      TEXT NOT NULL,     -- the id the PC reports for store_devices
  machine_id     TEXT,              -- hardware fingerprint, when the PC could read one
  ip             TEXT,
  requested_name TEXT NOT NULL,      -- exactly what was typed in the installer
  app_version    TEXT,
  user_agent     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_store_provisions_device ON store_provisions(device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_store_provisions_machine ON store_provisions(machine_id, created_at DESC) WHERE machine_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_store_provisions_ip ON store_provisions(ip, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_store_provisions_created ON store_provisions(created_at DESC);

-- Server-wide switches the owner can flip from the admin panel without a
-- deploy. Right now there is exactly one: whether the public trial sign-up is
-- open. A per-store "turn off" only helps AFTER a store has been created, so
-- without this the owner can clean up an abusive run but cannot stop it.
CREATE TABLE IF NOT EXISTS app_flags (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS store_devices (
  id            SERIAL PRIMARY KEY,
  store_pk      INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  device_id     TEXT NOT NULL,
  device_name   TEXT,
  device_type   TEXT DEFAULT 'pc',               -- pc | android
  last_seen_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(store_pk, device_id)
);

CREATE TABLE IF NOT EXISTS store_api_tokens (
  id            SERIAL PRIMARY KEY,
  store_pk      INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  device_id     TEXT,
  label         TEXT,
  expires_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Shared sync columns pattern (applied per table) ──────────────────────────
-- local_id = original SQLite/Room integer PK (unique per store)
-- version / updated_at / device_id / deleted = conflict resolution

-- ─── Masters ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS customers (
  id            BIGSERIAL PRIMARY KEY,
  store_pk      INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  local_id      BIGINT NOT NULL,
  name          TEXT NOT NULL,
  phone         TEXT,
  address       TEXT,
  document_name TEXT,
  total_due     DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_credit  DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ,
  last_updated  TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version       INT NOT NULL DEFAULT 1,
  device_id     TEXT,
  deleted       BOOLEAN NOT NULL DEFAULT FALSE,
  sync_status   TEXT NOT NULL DEFAULT 'synced',
  UNIQUE(store_pk, local_id)
);
CREATE INDEX IF NOT EXISTS idx_customers_store_name ON customers(store_pk, name) WHERE NOT deleted;
CREATE INDEX IF NOT EXISTS idx_customers_updated ON customers(store_pk, updated_at);

CREATE TABLE IF NOT EXISTS suppliers (
  id            BIGSERIAL PRIMARY KEY,
  store_pk      INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  local_id      BIGINT NOT NULL,
  name          TEXT NOT NULL,
  address       TEXT,
  phone         TEXT,
  gstin         TEXT,
  dl_numbers    TEXT,
  total_due     DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_credit  DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version       INT NOT NULL DEFAULT 1,
  device_id     TEXT,
  deleted       BOOLEAN NOT NULL DEFAULT FALSE,
  sync_status   TEXT NOT NULL DEFAULT 'synced',
  UNIQUE(store_pk, local_id)
);
CREATE INDEX IF NOT EXISTS idx_suppliers_store_name ON suppliers(store_pk, name) WHERE NOT deleted;
CREATE INDEX IF NOT EXISTS idx_suppliers_updated ON suppliers(store_pk, updated_at);

CREATE TABLE IF NOT EXISTS doctors (
  id                   BIGSERIAL PRIMARY KEY,
  store_pk             INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  local_id             BIGINT NOT NULL,
  name                 TEXT NOT NULL,
  phone                TEXT,
  registration_number  TEXT,
  created_at           TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version              INT NOT NULL DEFAULT 1,
  device_id            TEXT,
  deleted              BOOLEAN NOT NULL DEFAULT FALSE,
  sync_status          TEXT NOT NULL DEFAULT 'synced',
  UNIQUE(store_pk, local_id)
);
CREATE INDEX IF NOT EXISTS idx_doctors_updated ON doctors(store_pk, updated_at);

CREATE TABLE IF NOT EXISTS medicines (
  id            BIGSERIAL PRIMARY KEY,
  store_pk      INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  local_id      BIGINT NOT NULL,
  name          TEXT NOT NULL,
  type          TEXT,
  stock_qty     INT NOT NULL DEFAULT 0,
  unit          TEXT,
  gst_percent   DOUBLE PRECISION,
  mrp           DOUBLE PRECISION,
  rate          DOUBLE PRECISION,
  manufacturer  TEXT,
  batch_no      TEXT,
  expiry_date   DATE,
  hsn_code      TEXT,
  schedule      TEXT,
  location      TEXT,
  content_drug  TEXT,
  -- Where the shop got this stock. Written by opening stock, which has no bill
  -- behind it to carry a supplier. Reference only: no supplier row, no due.
  supplier_name TEXT,
  is_hidden     BOOLEAN NOT NULL DEFAULT FALSE,
  synced_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version       INT NOT NULL DEFAULT 1,
  device_id     TEXT,
  deleted       BOOLEAN NOT NULL DEFAULT FALSE,
  sync_status   TEXT NOT NULL DEFAULT 'synced',
  UNIQUE(store_pk, local_id)
);
CREATE INDEX IF NOT EXISTS idx_medicines_store_name ON medicines(store_pk, name) WHERE NOT deleted;
CREATE INDEX IF NOT EXISTS idx_medicines_name_batch ON medicines(store_pk, name, batch_no) WHERE NOT deleted;
CREATE INDEX IF NOT EXISTS idx_medicines_stock ON medicines(store_pk, stock_qty) WHERE NOT deleted AND NOT is_hidden;
CREATE INDEX IF NOT EXISTS idx_medicines_expiry ON medicines(store_pk, expiry_date) WHERE NOT deleted;
CREATE INDEX IF NOT EXISTS idx_medicines_updated ON medicines(store_pk, updated_at);

CREATE TABLE IF NOT EXISTS medicines_master (
  id            BIGSERIAL PRIMARY KEY,
  store_pk      INT REFERENCES stores(id) ON DELETE CASCADE, -- NULL = global catalog
  name          TEXT NOT NULL,
  manufacturer  TEXT,
  mrp           DOUBLE PRECISION,
  content_drug  TEXT,
  med_type      TEXT,
  pack_size     TEXT,
  schedule      TEXT,
  hsn_code      TEXT,
  gst_percent   DOUBLE PRECISION,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_med_master_name ON medicines_master(name);

-- ─── Sales ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sales (
  id               BIGSERIAL PRIMARY KEY,
  store_pk         INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  local_id         BIGINT NOT NULL,
  bill_no          TEXT NOT NULL,
  customer_id      BIGINT,                       -- local_id of customer
  bill_date        DATE NOT NULL,
  total_amount     DOUBLE PRECISION NOT NULL DEFAULT 0,
  discount         DOUBLE PRECISION NOT NULL DEFAULT 0,
  discount_pct     DOUBLE PRECISION NOT NULL DEFAULT 0,
  rounding         DOUBLE PRECISION NOT NULL DEFAULT 0,
  amount_paid      DOUBLE PRECISION NOT NULL DEFAULT 0,
  cash_paid        DOUBLE PRECISION NOT NULL DEFAULT 0,
  online_paid      DOUBLE PRECISION NOT NULL DEFAULT 0,
  previous_due     DOUBLE PRECISION NOT NULL DEFAULT 0,
  previous_credit  DOUBLE PRECISION NOT NULL DEFAULT 0,
  due_amount       DOUBLE PRECISION NOT NULL DEFAULT 0,
  credit_amount    DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_due        DOUBLE PRECISION NOT NULL DEFAULT 0,
  paid_due         DOUBLE PRECISION NOT NULL DEFAULT 0,
  bill_cleared     BOOLEAN NOT NULL DEFAULT FALSE,
  account_cleared  BOOLEAN NOT NULL DEFAULT FALSE,
  doctor_name      TEXT,
  is_autosave      BOOLEAN NOT NULL DEFAULT FALSE,
  fy_start_year    INT,
  fy_serial        INT,
  customer_name    TEXT,
  customer_phone   TEXT,
  customer_address TEXT,
  item_count       INT NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version          INT NOT NULL DEFAULT 1,
  device_id        TEXT,
  deleted          BOOLEAN NOT NULL DEFAULT FALSE,
  sync_status      TEXT NOT NULL DEFAULT 'synced',
  UNIQUE(store_pk, local_id),
  UNIQUE(store_pk, bill_no)
);
CREATE INDEX IF NOT EXISTS idx_sales_store_date ON sales(store_pk, bill_date DESC) WHERE NOT deleted;
CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(store_pk, customer_id) WHERE NOT deleted;
CREATE INDEX IF NOT EXISTS idx_sales_fy ON sales(store_pk, fy_start_year, fy_serial);
CREATE INDEX IF NOT EXISTS idx_sales_updated ON sales(store_pk, updated_at);

CREATE TABLE IF NOT EXISTS sales_items (
  id            BIGSERIAL PRIMARY KEY,
  store_pk      INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  sale_id       BIGINT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  medicine_id   BIGINT,                          -- local_id of medicine
  name          TEXT,
  type          TEXT,
  batch_no      TEXT,
  expiry_date   TEXT,
  hsn_code      TEXT,
  schedule      TEXT,
  manufacturer  TEXT,
  qty           INT NOT NULL DEFAULT 0,
  rate          DOUBLE PRECISION NOT NULL DEFAULT 0,
  gst_percent   DOUBLE PRECISION,
  amount        DOUBLE PRECISION NOT NULL DEFAULT 0,
  item_discount DOUBLE PRECISION NOT NULL DEFAULT 0,
  cost_price    DOUBLE PRECISION NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sales_items_sale ON sales_items(sale_id);

-- ─── Purchases ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS purchases (
  id                    BIGSERIAL PRIMARY KEY,
  store_pk              INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  local_id              BIGINT NOT NULL,
  purchase_no           TEXT NOT NULL,
  supplier_id           BIGINT,
  purchase_date         DATE NOT NULL,
  bill_number           TEXT,
  subtotal              DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_gst             DOUBLE PRECISION NOT NULL DEFAULT 0,
  cgst                  DOUBLE PRECISION NOT NULL DEFAULT 0,
  sgst                  DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_amount          DOUBLE PRECISION NOT NULL DEFAULT 0,
  overall_discount      DOUBLE PRECISION NOT NULL DEFAULT 0,
  rounding              DOUBLE PRECISION NOT NULL DEFAULT 0,
  need_to_pay           DOUBLE PRECISION NOT NULL DEFAULT 0,
  final_amount          DOUBLE PRECISION NOT NULL DEFAULT 0,
  amount_paid           DOUBLE PRECISION NOT NULL DEFAULT 0,
  amount_paid_at_entry  DOUBLE PRECISION NOT NULL DEFAULT 0,
  cash_paid_at_entry    DOUBLE PRECISION NOT NULL DEFAULT 0,
  online_paid_at_entry  DOUBLE PRECISION NOT NULL DEFAULT 0,
  previous_due          DOUBLE PRECISION NOT NULL DEFAULT 0,
  previous_credit       DOUBLE PRECISION NOT NULL DEFAULT 0,
  due                   DOUBLE PRECISION NOT NULL DEFAULT 0,
  current_credit        DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_due             DOUBLE PRECISION NOT NULL DEFAULT 0,
  due_amount            DOUBLE PRECISION NOT NULL DEFAULT 0,
  credit_amount         DOUBLE PRECISION NOT NULL DEFAULT 0,
  paid_due              DOUBLE PRECISION NOT NULL DEFAULT 0,
  bill_cleared          BOOLEAN NOT NULL DEFAULT FALSE,
  account_cleared       BOOLEAN NOT NULL DEFAULT FALSE,
  gst_calc_method       TEXT,
  expenditure           DOUBLE PRECISION NOT NULL DEFAULT 0,
  is_autosave           BOOLEAN NOT NULL DEFAULT FALSE,
  fy_start_year         INT,
  fy_serial             INT,
  supplier_name         TEXT,
  supplier_phone        TEXT,
  item_count            INT NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version               INT NOT NULL DEFAULT 1,
  device_id             TEXT,
  deleted               BOOLEAN NOT NULL DEFAULT FALSE,
  sync_status           TEXT NOT NULL DEFAULT 'synced',
  UNIQUE(store_pk, local_id),
  UNIQUE(store_pk, purchase_no)
);
CREATE INDEX IF NOT EXISTS idx_purchases_store_date ON purchases(store_pk, purchase_date DESC) WHERE NOT deleted;
CREATE INDEX IF NOT EXISTS idx_purchases_supplier ON purchases(store_pk, supplier_id) WHERE NOT deleted;
CREATE INDEX IF NOT EXISTS idx_purchases_updated ON purchases(store_pk, updated_at);

CREATE TABLE IF NOT EXISTS purchase_items (
  id              BIGSERIAL PRIMARY KEY,
  store_pk        INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  purchase_id     BIGINT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  medicine_id     BIGINT,
  name            TEXT,
  qty             DOUBLE PRECISION NOT NULL DEFAULT 0,
  free_qty        DOUBLE PRECISION NOT NULL DEFAULT 0,
  type            TEXT,
  hsn_code        TEXT,
  gst_pct         DOUBLE PRECISION NOT NULL DEFAULT 0,
  mrp             DOUBLE PRECISION NOT NULL DEFAULT 0,
  rate            DOUBLE PRECISION NOT NULL DEFAULT 0,
  manufacturer    TEXT,
  batch_no        TEXT,
  expiry_date     TEXT,
  schedule        TEXT,
  discount_pct    DOUBLE PRECISION NOT NULL DEFAULT 0,
  taxable         DOUBLE PRECISION NOT NULL DEFAULT 0,
  gst_amt         DOUBLE PRECISION NOT NULL DEFAULT 0,
  item_amount     DOUBLE PRECISION NOT NULL DEFAULT 0,
  unit            TEXT,
  tablets_per_stripe INT
);
CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON purchase_items(purchase_id);

-- ─── Payments ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS customer_payments (
  id              BIGSERIAL PRIMARY KEY,
  store_pk        INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  local_id        BIGINT NOT NULL,
  customer_id     BIGINT NOT NULL,
  customer_name   TEXT,
  payment_date    DATE NOT NULL,
  amount          DOUBLE PRECISION NOT NULL DEFAULT 0,
  payment_mode    TEXT NOT NULL DEFAULT 'cash',
  cash_amount     DOUBLE PRECISION NOT NULL DEFAULT 0,
  online_amount   DOUBLE PRECISION NOT NULL DEFAULT 0,
  reference_no    TEXT,
  note            TEXT,
  created_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version         INT NOT NULL DEFAULT 1,
  device_id       TEXT,
  deleted         BOOLEAN NOT NULL DEFAULT FALSE,
  sync_status     TEXT NOT NULL DEFAULT 'synced',
  UNIQUE(store_pk, local_id)
);
CREATE INDEX IF NOT EXISTS idx_cust_pay_updated ON customer_payments(store_pk, updated_at);

CREATE TABLE IF NOT EXISTS supplier_payments (
  id              BIGSERIAL PRIMARY KEY,
  store_pk        INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  local_id        BIGINT NOT NULL,
  payment_no      TEXT NOT NULL,
  supplier_id     BIGINT NOT NULL,
  supplier_name   TEXT,
  payment_date    DATE NOT NULL,
  amount          DOUBLE PRECISION NOT NULL DEFAULT 0,
  mode            TEXT NOT NULL DEFAULT 'Cash',
  reference       TEXT,
  due_before      DOUBLE PRECISION NOT NULL DEFAULT 0,
  due_after       DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version         INT NOT NULL DEFAULT 1,
  device_id       TEXT,
  deleted         BOOLEAN NOT NULL DEFAULT FALSE,
  sync_status     TEXT NOT NULL DEFAULT 'synced',
  UNIQUE(store_pk, local_id),
  UNIQUE(store_pk, payment_no)
);
CREATE INDEX IF NOT EXISTS idx_supp_pay_updated ON supplier_payments(store_pk, updated_at);

-- ─── Returns ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sales_returns (
  id              BIGSERIAL PRIMARY KEY,
  store_pk        INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  local_id        BIGINT NOT NULL,
  return_no       TEXT NOT NULL,
  sale_id         BIGINT,
  bill_no         TEXT,
  customer_id     BIGINT,
  customer_name   TEXT,
  return_date     DATE NOT NULL,
  refund_amount   DOUBLE PRECISION NOT NULL DEFAULT 0,
  discount        DOUBLE PRECISION NOT NULL DEFAULT 0,
  reason          TEXT,
  item_count      INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version         INT NOT NULL DEFAULT 1,
  device_id       TEXT,
  deleted         BOOLEAN NOT NULL DEFAULT FALSE,
  sync_status     TEXT NOT NULL DEFAULT 'synced',
  UNIQUE(store_pk, local_id),
  UNIQUE(store_pk, return_no)
);
CREATE INDEX IF NOT EXISTS idx_sales_ret_updated ON sales_returns(store_pk, updated_at);

CREATE TABLE IF NOT EXISTS sales_return_items (
  id            BIGSERIAL PRIMARY KEY,
  store_pk      INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  return_id     BIGINT NOT NULL REFERENCES sales_returns(id) ON DELETE CASCADE,
  medicine_id   BIGINT,
  name          TEXT,
  batch_no      TEXT,
  qty           DOUBLE PRECISION NOT NULL DEFAULT 0,
  rate          DOUBLE PRECISION NOT NULL DEFAULT 0,
  amount        DOUBLE PRECISION NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS purchase_returns (
  id              BIGSERIAL PRIMARY KEY,
  store_pk        INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  local_id        BIGINT NOT NULL,
  return_no       TEXT NOT NULL,
  purchase_id     BIGINT,
  purchase_no     TEXT,
  supplier_id     BIGINT,
  supplier_name   TEXT,
  return_date     DATE NOT NULL,
  refund_amount   DOUBLE PRECISION NOT NULL DEFAULT 0,
  discount        DOUBLE PRECISION NOT NULL DEFAULT 0,
  reason          TEXT,
  item_count      INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version         INT NOT NULL DEFAULT 1,
  device_id       TEXT,
  deleted         BOOLEAN NOT NULL DEFAULT FALSE,
  sync_status     TEXT NOT NULL DEFAULT 'synced',
  UNIQUE(store_pk, local_id),
  UNIQUE(store_pk, return_no)
);
CREATE INDEX IF NOT EXISTS idx_purch_ret_updated ON purchase_returns(store_pk, updated_at);

CREATE TABLE IF NOT EXISTS purchase_return_items (
  id            BIGSERIAL PRIMARY KEY,
  store_pk      INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  return_id     BIGINT NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
  medicine_id   BIGINT,
  name          TEXT,
  batch_no      TEXT,
  qty           DOUBLE PRECISION NOT NULL DEFAULT 0,
  rate          DOUBLE PRECISION NOT NULL DEFAULT 0,
  amount        DOUBLE PRECISION NOT NULL DEFAULT 0
);

-- ─── Settings / Local-only feature tables ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS pharmacy_profiles (
  store_pk      INT PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  name          TEXT,
  address       TEXT,
  phone         TEXT,
  email         TEXT,
  gstin         TEXT,
  dl_number     TEXT,
  gst_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
  fssai_number  TEXT,
  show_fssai_on_bill BOOLEAN NOT NULL DEFAULT FALSE,
  logo_path     TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version       INT NOT NULL DEFAULT 1,
  device_id     TEXT
);

CREATE TABLE IF NOT EXISTS store_settings (
  id            BIGSERIAL PRIMARY KEY,
  store_pk      INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  value         TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(store_pk, name)
);

CREATE TABLE IF NOT EXISTS store_dropdowns (
  store_pk          INT PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  villages          JSONB NOT NULL DEFAULT '[]',
  default_village   TEXT,
  med_types         JSONB NOT NULL DEFAULT '[]',
  schedules         JSONB NOT NULL DEFAULT '[]',
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS general_products (
  id            BIGSERIAL PRIMARY KEY,
  store_pk      INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  local_id      BIGINT NOT NULL,
  name          TEXT NOT NULL,
  rate          DOUBLE PRECISION NOT NULL DEFAULT 0,
  mrp           DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version       INT NOT NULL DEFAULT 1,
  device_id     TEXT,
  deleted       BOOLEAN NOT NULL DEFAULT FALSE,
  sync_status   TEXT NOT NULL DEFAULT 'synced',
  UNIQUE(store_pk, local_id)
);

CREATE TABLE IF NOT EXISTS stock_disposals (
  id                    BIGSERIAL PRIMARY KEY,
  store_pk              INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  local_id              BIGINT NOT NULL,
  disposal_no           TEXT,
  medicine_id           BIGINT,
  batch_no              TEXT,
  supplier_id           BIGINT,
  purchase_id           BIGINT,
  bill_number           TEXT,
  qty                   DOUBLE PRECISION NOT NULL DEFAULT 0,
  original_purchase_qty DOUBLE PRECISION,
  disposal_type         TEXT,
  reason                TEXT,
  expected_credit_note  BOOLEAN NOT NULL DEFAULT FALSE,
  notes                 TEXT,
  disposal_date         DATE,
  created_at            TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version               INT NOT NULL DEFAULT 1,
  device_id             TEXT,
  deleted               BOOLEAN NOT NULL DEFAULT FALSE,
  sync_status           TEXT NOT NULL DEFAULT 'synced',
  UNIQUE(store_pk, local_id)
);

CREATE TABLE IF NOT EXISTS pending_orders (
  id                      BIGSERIAL PRIMARY KEY,
  store_pk                INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  local_id                BIGINT NOT NULL,
  order_no                TEXT,
  medicine_id             BIGINT,
  medicine_name           TEXT,
  pack_size               TEXT,
  supplier_id             BIGINT,
  supplier_name_manual    TEXT,
  supplier_phone          TEXT,
  supplier_email          TEXT,
  order_offline           BOOLEAN NOT NULL DEFAULT FALSE,
  offline_note            TEXT,
  qty                     DOUBLE PRECISION NOT NULL DEFAULT 0,
  unit_price              DOUBLE PRECISION NOT NULL DEFAULT 0,
  current_stock           DOUBLE PRECISION NOT NULL DEFAULT 0,
  min_stock               DOUBLE PRECISION NOT NULL DEFAULT 0,
  order_date              DATE,
  expected_delivery_date  DATE,
  order_group_id          TEXT,
  status                  TEXT DEFAULT 'draft',
  notes                   TEXT,
  created_at              TIMESTAMPTZ,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version                 INT NOT NULL DEFAULT 1,
  device_id               TEXT,
  deleted                 BOOLEAN NOT NULL DEFAULT FALSE,
  sync_status             TEXT NOT NULL DEFAULT 'synced',
  UNIQUE(store_pk, local_id)
);

-- ─── Shelf layout (Mac2 + Android) ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS racks (
  id            BIGSERIAL PRIMARY KEY,
  store_pk      INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  local_id      BIGINT NOT NULL,
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version       INT NOT NULL DEFAULT 1,
  device_id     TEXT,
  deleted       BOOLEAN NOT NULL DEFAULT FALSE,
  sync_status   TEXT NOT NULL DEFAULT 'synced',
  UNIQUE(store_pk, local_id)
);

CREATE TABLE IF NOT EXISTS sections (
  id            BIGSERIAL PRIMARY KEY,
  store_pk      INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  local_id      BIGINT NOT NULL,
  rack_id       BIGINT,
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version       INT NOT NULL DEFAULT 1,
  device_id     TEXT,
  deleted       BOOLEAN NOT NULL DEFAULT FALSE,
  sync_status   TEXT NOT NULL DEFAULT 'synced',
  UNIQUE(store_pk, local_id)
);

CREATE TABLE IF NOT EXISTS boxes (
  id            BIGSERIAL PRIMARY KEY,
  store_pk      INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  local_id      BIGINT NOT NULL,
  section_id    BIGINT,
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version       INT NOT NULL DEFAULT 1,
  device_id     TEXT,
  deleted       BOOLEAN NOT NULL DEFAULT FALSE,
  sync_status   TEXT NOT NULL DEFAULT 'synced',
  UNIQUE(store_pk, local_id)
);

CREATE TABLE IF NOT EXISTS shelves (
  id            BIGSERIAL PRIMARY KEY,
  store_pk      INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  local_id      BIGINT NOT NULL,
  shelf_no      TEXT,
  description   TEXT,
  created_at    TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version       INT NOT NULL DEFAULT 1,
  device_id     TEXT,
  deleted       BOOLEAN NOT NULL DEFAULT FALSE,
  sync_status   TEXT NOT NULL DEFAULT 'synced',
  UNIQUE(store_pk, local_id)
);

CREATE TABLE IF NOT EXISTS medicine_shelf (
  id            BIGSERIAL PRIMARY KEY,
  store_pk      INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  local_id      BIGINT NOT NULL,
  medicine_id   BIGINT,
  shelf_id      BIGINT,
  created_at    TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version       INT NOT NULL DEFAULT 1,
  device_id     TEXT,
  deleted       BOOLEAN NOT NULL DEFAULT FALSE,
  sync_status   TEXT NOT NULL DEFAULT 'synced',
  UNIQUE(store_pk, local_id)
);

CREATE TABLE IF NOT EXISTS shelf_settings (
  store_pk      INT PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  show_location BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version       INT NOT NULL DEFAULT 1,
  device_id     TEXT
);

CREATE TABLE IF NOT EXISTS medicine_suppliers (
  id                  BIGSERIAL PRIMARY KEY,
  store_pk            INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  local_id            BIGINT NOT NULL,
  medicine_name       TEXT NOT NULL,
  supplier_id         BIGINT NOT NULL,
  last_rate           DOUBLE PRECISION NOT NULL DEFAULT 0,
  last_purchase_date  DATE,
  created_at          TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version             INT NOT NULL DEFAULT 1,
  device_id           TEXT,
  deleted             BOOLEAN NOT NULL DEFAULT FALSE,
  sync_status         TEXT NOT NULL DEFAULT 'synced',
  UNIQUE(store_pk, local_id),
  UNIQUE(store_pk, medicine_name, supplier_id)
);

-- Ensure general_products has sync_status (idempotent for older DBs)
ALTER TABLE general_products ADD COLUMN IF NOT EXISTS sync_status TEXT NOT NULL DEFAULT 'synced';
-- medicines_master sync meta + catalog extras (global catalog uses store_pk IS NULL)
ALTER TABLE medicines_master ADD COLUMN IF NOT EXISTS local_id BIGINT;
ALTER TABLE medicines_master ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE medicines_master ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;
ALTER TABLE medicines_master ADD COLUMN IF NOT EXISTS device_id TEXT;
ALTER TABLE medicines_master ADD COLUMN IF NOT EXISTS deleted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE medicines_master ADD COLUMN IF NOT EXISTS sync_status TEXT NOT NULL DEFAULT 'synced';
ALTER TABLE medicines_master ADD COLUMN IF NOT EXISTS schedule TEXT;
ALTER TABLE medicines_master ADD COLUMN IF NOT EXISTS hsn_code TEXT;
ALTER TABLE medicines_master ADD COLUMN IF NOT EXISTS gst_percent DOUBLE PRECISION;
CREATE UNIQUE INDEX IF NOT EXISTS idx_med_master_store_local
  ON medicines_master (store_pk, local_id) WHERE local_id IS NOT NULL;
-- One global row per medicine name (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS idx_med_master_global_name
  ON medicines_master (LOWER(TRIM(name)))
  WHERE store_pk IS NULL AND NOT deleted;

-- FY serial allocation lock table (atomic next serial)
CREATE TABLE IF NOT EXISTS fy_serials (
  store_pk       INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,                  -- sales | purchases
  fy_start_year  INT NOT NULL,
  last_serial    INT NOT NULL DEFAULT 0,
  PRIMARY KEY (store_pk, kind, fy_start_year)
);

-- Sync watermarks (server-side optional; clients may keep their own)
CREATE TABLE IF NOT EXISTS sync_watermarks (
  store_pk       INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  collection     TEXT NOT NULL,
  watermark      TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01',
  PRIMARY KEY (store_pk, collection)
);

-- Admin audit log
CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGSERIAL PRIMARY KEY,
  actor_type    TEXT NOT NULL,                   -- admin | store | system
  actor_id      TEXT,
  action        TEXT NOT NULL,
  store_pk      INT,
  meta          JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);

-- ─── Option B sync: monotonic revision + append-only changelog ────────────────
-- Watermark APIs remain for backward compatibility during migration.

CREATE TABLE IF NOT EXISTS store_sync_state (
  store_pk       INT PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  head_revision  BIGINT NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sync_changes (
  id                 BIGSERIAL PRIMARY KEY,
  store_pk           INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  revision           BIGINT NOT NULL,
  collection         TEXT NOT NULL,
  local_id           BIGINT NOT NULL,
  operation          TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  entity_version     INT,
  entity_updated_at  TIMESTAMPTZ,
  device_id          TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (store_pk, revision)
);
CREATE INDEX IF NOT EXISTS idx_sync_changes_pull
  ON sync_changes (store_pk, revision);
CREATE INDEX IF NOT EXISTS idx_sync_changes_entity
  ON sync_changes (store_pk, collection, local_id, revision DESC);

CREATE TABLE IF NOT EXISTS device_sync_state (
  store_pk            INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  device_id           TEXT NOT NULL,
  last_ack_revision   BIGINT NOT NULL DEFAULT 0,
  last_seen_at        TIMESTAMPTZ,
  PRIMARY KEY (store_pk, device_id)
);

-- One-time backfill: every store starts at head_revision = 0
INSERT INTO store_sync_state (store_pk, head_revision)
SELECT id, 0 FROM stores
ON CONFLICT (store_pk) DO NOTHING;

-- ─── Option B Phase B4 ───────────────────────────────────────────────────────
-- B4.1: stable client-generated UUIDs (idempotent create across devices)
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS client_uuid TEXT;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS client_uuid TEXT;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS client_uuid TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_medicines_client_uuid
  ON medicines (store_pk, client_uuid) WHERE client_uuid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_client_uuid
  ON sales (store_pk, client_uuid) WHERE client_uuid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_purchases_client_uuid
  ON purchases (store_pk, client_uuid) WHERE client_uuid IS NOT NULL;

-- B4.2: append-only stock delta log (apply once per op_uuid)
CREATE TABLE IF NOT EXISTS stock_operations (
  id              BIGSERIAL PRIMARY KEY,
  store_pk        INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  local_id        BIGINT NOT NULL,
  op_uuid         TEXT NOT NULL,
  medicine_id     BIGINT NOT NULL,              -- medicine local_id
  op              TEXT NOT NULL,                -- sale|purchase|return|adjust|disposal|set
  qty_delta       INT NOT NULL,
  ref_collection  TEXT,
  ref_id          BIGINT,
  revision        BIGINT,
  device_id       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (store_pk, op_uuid),
  UNIQUE (store_pk, local_id)
);
CREATE INDEX IF NOT EXISTS idx_stock_ops_medicine
  ON stock_operations (store_pk, medicine_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_ops_revision
  ON stock_operations (store_pk, revision);

-- Purchase line pack (strip size) so edit stock uses qty × pack, not qty as tablets.
ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS unit TEXT;
ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS tablets_per_stripe INT;

UPDATE purchase_items pi
SET
  unit = COALESCE(NULLIF(btrim(pi.unit), ''), NULLIF(btrim(m.unit), '')),
  tablets_per_stripe = COALESCE(
    pi.tablets_per_stripe,
    CASE
      WHEN (regexp_match(COALESCE(m.unit, ''), '1\s*[Xx×*]\s*(\d+)'))[1] IS NOT NULL
        THEN (regexp_match(m.unit, '1\s*[Xx×*]\s*(\d+)'))[1]::int
      WHEN COALESCE(m.unit, '') ~ '^[0-9]+([.][0-9]+)?'
        THEN floor(substring(m.unit from '^[0-9]+')::numeric)::int
      WHEN COALESCE(m.unit, '') ~ '[0-9]+'
        THEN (regexp_match(m.unit, '[0-9]+'))[1]::int
      ELSE NULL
    END
  )
FROM medicines m
WHERE m.store_pk = pi.store_pk
  AND m.local_id = pi.medicine_id
  AND (
    pi.unit IS NULL OR btrim(pi.unit) = ''
    OR pi.tablets_per_stripe IS NULL
  );

-- Logins for the sales demonstration site (demo.satpudacore.online).
-- Not store devices and not administrators: a demo account opens the
-- demonstration copy of the desktop UI and nothing else.
CREATE TABLE IF NOT EXISTS demo_users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT,
  note          TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ,
  login_count   INTEGER NOT NULL DEFAULT 0
);
