# Mac2 + Android → Satpuda Core Server migration plan

**Server:** `https://api.satpudacore.online`  
**VPS:** `200.234.32.222`  
**Firebase project:** `satpuda-core-online` (leave untouched; apps stop writing to it)

---

## Goal

Every Firebase read/write/delete/update in Mac2 and Satpuda Core Android becomes an HTTP call to the Node/Postgres API. SQLite stays for offline cache on both apps.

---

## Phase 0 — Data (done / in progress)

1. Confirm Firebase **reads** still work (quota may block writes only).
2. **Read-only** import all `stores/{store_id}/**` + `store_keys/**` into Postgres.
3. Preserve pairing keys (`SC-…`) as `stores.android_key`.
4. Verify admin UI shows each store’s sales/inventory/etc.

**Do not** disable Firebase until Phase 3 cutover.

---

## Phase 1 — Shared HTTP client (both apps)

Replace Firebase SDK calls with REST:

| Old Firebase | New API |
|--------------|---------|
| `store_keys/{SC-…}` validate | `POST /api/auth/pair` |
| `stores/{id}/{collection}/{doc}` set | `POST /api/sync/{collection}` |
| Batch sale/purchase | `POST /api/sync/bundle` |
| Listeners / pull since watermark | `GET /api/sync/{collection}?since=` |
| Soft delete | `DELETE /api/sync/{collection}/{id}` |
| Settings profile/dropdowns | `PUT/GET /api/sync/settings/*` |
| FY bill allocate (optional) | `POST /api/sync/fy/allocate` |

Auth header on all store calls: `Authorization: Bearer <token>` from pair.

Config: `API_BASE=https://api.satpudacore.online`

---

## Phase 2 — Mac2 (`mac2/core/firebase_sync.py` + desktop online path)

1. Add `core/server_api.py` (HTTP client, JWT store, retries).
2. In **online** mode, route `push_*` / `pull_*` / listeners to server API instead of Firestore.
3. Keep SQLite as local DB; server ACK required before commit (same as current online guard).
4. Pairing UI: still enter `SC-…` + store name → call `/api/auth/pair` → save token + `store_id`.
5. Watermarks file stays; use server `meta.server_time`.
6. Conflict fields unchanged: `version`, `updated_at`, `device_id`, `deleted`.
7. Feature parity checklist:
   - Activation / license gate (local) + store pair (server)
   - Customers, suppliers, doctors CRUD
   - Medicines CRUD + stock
   - Sales save/edit/history/delete
   - Purchases save/edit/history/delete
   - Payments, returns
   - Pharmacy profile, villages/dropdowns, settings KV
   - Sync Now / full pull

---

## Phase 3 — Android (`FirebaseManager` / `FirebaseSyncHelper` / services)

1. Add Retrofit/OkHttp client to `api.satpudacore.online`.
2. Replace `FirebaseManager.syncDoc` / batch / listeners with server sync.
3. `StoreIdProvider` + activation key → `/api/auth/pair`.
4. Keep Room/SQLite offline; online mutations require server success (existing `OnlineGuard` pattern).
5. Same collection list and bundle order as Mac2.
6. Remove Firebase BOM deps only after cutover verified.

---

## Phase 4 — Cutover

1. Both apps release with server backend + feature flag `backend=server|firebase`.
2. Pilot 1–2 stores on server.
3. Default all new installs to server.
4. Freeze Firebase writes (apps no longer call Firestore).
5. Optional final read-only re-import for delta.
6. Keep Firebase project read-only archive; do not delete immediately.

---

## Operations map (must all hit server)

- Auth/pair, store list on device  
- Customer / supplier / doctor create-update-delete  
- Medicine create-update-hide-delete + stock changes  
- Sale create-update-delete + line items  
- Purchase create-update-delete + line items  
- Customer/supplier payments  
- Sales/purchase returns  
- Pharmacy profile, dropdowns/villages, settings KV  
- Pull/bootstrap/incremental sync  
- Soft-delete + conflict merge  

---

## Risk notes

- Firebase **write** quota exhausted ≠ reads blocked (we verified reads).  
- Integer `local_id` per store must be preserved for multi-device sync.  
- Multiple historical `SC-` keys may point at one store; importer keeps one active key (can regenerate in admin).  
- Offline mode: SQLite only until online; then push queue to server.
