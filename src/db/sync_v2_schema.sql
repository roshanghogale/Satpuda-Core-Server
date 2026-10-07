-- Offline-first sync (v2), phase 1. Additive only: every statement is IF NOT EXISTS, nothing
-- existing is altered, so it can run on the live database while shops keep billing.
--
-- Design: "Satpuda Core: Offline-First Server Design" (owner's doc, 7 Oct 2026).
--   * every device that syncs with v2 is registered and gets a small device number; the ids
--     it makes itself start at device_no * 1,000,000,000, so two offline devices never create
--     the same id (every id in use today is below 1,000,000,000);
--   * every save a device makes is an event with that device's own sequence number; the
--     server keeps each one forever (device_events) and can tell when one is missing;
--   * bill / purchase numbers come from blocks a device reserves in advance (number_blocks);
--   * a nightly check compares stock with the stock ledger and dues with the party ledger.

CREATE TABLE IF NOT EXISTS sync_devices (
  id            SERIAL PRIMARY KEY,
  store_pk      INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  install_id    TEXT NOT NULL,
  device_no     INTEGER NOT NULL,
  device_type   TEXT,
  device_name   TEXT,
  app_version   TEXT,
  last_seq      BIGINT NOT NULL DEFAULT 0,
  last_seen_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (store_pk, install_id),
  UNIQUE (store_pk, device_no)
);

CREATE TABLE IF NOT EXISTS device_events (
  id            BIGSERIAL PRIMARY KEY,
  store_pk      INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  device_no     INTEGER NOT NULL,
  seq           BIGINT NOT NULL,
  event_uuid    TEXT NOT NULL,
  collection    TEXT NOT NULL,
  op            TEXT NOT NULL,              -- upsert | delete | stock
  local_id      BIGINT,
  base_version  INTEGER,
  payload       JSONB NOT NULL,             -- the event exactly as the device sent it
  outcome       TEXT NOT NULL,              -- applied | flagged | quarantined
  flag_code     TEXT,
  flag_detail   TEXT,
  replaced_doc  JSONB,                      -- the server's copy an edit replaced, on a clash
  device_time   TIMESTAMPTZ,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ,
  resolved_note TEXT,
  UNIQUE (store_pk, device_no, seq),
  UNIQUE (store_pk, event_uuid)
);
CREATE INDEX IF NOT EXISTS idx_device_events_open
  ON device_events (store_pk, received_at DESC) WHERE outcome <> 'applied' AND resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_device_events_doc
  ON device_events (store_pk, collection, local_id);

CREATE TABLE IF NOT EXISTS number_blocks (
  id            BIGSERIAL PRIMARY KEY,
  store_pk      INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,              -- sales | purchases
  fy_start_year INTEGER NOT NULL,
  device_no     INTEGER NOT NULL,
  from_serial   INTEGER NOT NULL,
  to_serial     INTEGER NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (store_pk, kind, fy_start_year, from_serial)
);
CREATE INDEX IF NOT EXISTS idx_number_blocks_top
  ON number_blocks (store_pk, kind, fy_start_year, to_serial DESC);

CREATE TABLE IF NOT EXISTS stock_snapshots (
  store_pk      INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  medicine_id   BIGINT NOT NULL,
  stock_qty     INTEGER NOT NULL,
  PRIMARY KEY (store_pk, medicine_id)
);

CREATE TABLE IF NOT EXISTS sync_check_runs (
  id               BIGSERIAL PRIMARY KEY,
  store_pk         INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  run_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  baseline         BOOLEAN NOT NULL DEFAULT FALSE,
  stock_checked    INTEGER NOT NULL DEFAULT 0,
  stock_mismatches INTEGER NOT NULL DEFAULT 0,
  dues_checked     INTEGER NOT NULL DEFAULT 0,
  dues_mismatches  INTEGER NOT NULL DEFAULT 0,
  open_flags       INTEGER NOT NULL DEFAULT 0,
  last_op_id       BIGINT NOT NULL DEFAULT 0,   -- stock_operations.id the run counted up to
  notes            TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_check_runs_store ON sync_check_runs (store_pk, run_at DESC);

CREATE TABLE IF NOT EXISTS sync_check_items (
  id         BIGSERIAL PRIMARY KEY,
  run_id     BIGINT NOT NULL REFERENCES sync_check_runs(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                 -- stock | customer_due | supplier_due
  ref_id     BIGINT,
  label      TEXT,
  expected   NUMERIC,
  actual     NUMERIC,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_check_items_run ON sync_check_items (run_id);
