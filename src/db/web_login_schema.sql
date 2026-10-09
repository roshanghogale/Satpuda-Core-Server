-- Web login (phase 5 of the offline-first plan, owner's decisions 9 Oct 2026).
-- Additive only: every statement is IF NOT EXISTS, nothing existing is altered.
--
--   * a shop works from any browser with an ID and a password; the web is ONLINE-ONLY for good
--     (no copy of the shop in the browser), every screen reads and writes through this server;
--   * the vendor admin panel creates the store OWNER login and STAFF logins; the owner, signed
--     into the web, adds and manages staff; every login has its own permissions;
--   * passwords are stored only as scrypt hashes (the scheme Satpuda Health uses);
--   * sessions are server-side rows, so disabling a login or resetting a password signs it out
--     at once, not when a token runs out;
--   * every write a web user makes is recorded in web_audit (who made which bill).

CREATE TABLE IF NOT EXISTS web_users (
  id                    SERIAL PRIMARY KEY,
  store_pk              INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  username              TEXT NOT NULL,
  full_name             TEXT,
  role                  TEXT NOT NULL DEFAULT 'staff',     -- owner | staff
  permissions           JSONB NOT NULL DEFAULT '[]',       -- staff only; an owner has every one
  password_hash         TEXT NOT NULL,
  must_change_password  BOOLEAN NOT NULL DEFAULT TRUE,
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  failed_logins         INTEGER NOT NULL DEFAULT 0,
  locked_until          TIMESTAMPTZ,
  created_by            TEXT,                              -- admin:<name> | web:<username>
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at         TIMESTAMPTZ,
  CONSTRAINT web_users_role_chk CHECK (role IN ('owner', 'staff'))
);
-- One ID across all shops, so signing in needs only the ID and the password.
CREATE UNIQUE INDEX IF NOT EXISTS uq_web_users_username ON web_users (LOWER(username));
CREATE INDEX IF NOT EXISTS idx_web_users_store ON web_users (store_pk);

CREATE TABLE IF NOT EXISTS web_sessions (
  id            BIGSERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES web_users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,                      -- sha256 of the bearer token
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  ip            TEXT,
  user_agent    TEXT
);
CREATE INDEX IF NOT EXISTS idx_web_sessions_user ON web_sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS web_audit (
  id          BIGSERIAL PRIMARY KEY,
  store_pk    INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  user_id     INTEGER,
  username    TEXT,
  action      TEXT NOT NULL,                               -- sale.create, purchase.edit, staff.add ...
  collection  TEXT,
  local_id    BIGINT,
  ref_no      TEXT,                                        -- bill / purchase / payment number
  detail      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_web_audit_store ON web_audit (store_pk, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_web_audit_doc ON web_audit (store_pk, collection, local_id);

-- (C) a medicine's details flow into its old bill lines: one UPDATE by medicine id each.
CREATE INDEX IF NOT EXISTS idx_sales_items_medicine ON sales_items (store_pk, medicine_id);
CREATE INDEX IF NOT EXISTS idx_purchase_items_medicine ON purchase_items (store_pk, medicine_id);
CREATE INDEX IF NOT EXISTS idx_sales_return_items_medicine ON sales_return_items (store_pk, medicine_id);
CREATE INDEX IF NOT EXISTS idx_purchase_return_items_medicine ON purchase_return_items (store_pk, medicine_id);
