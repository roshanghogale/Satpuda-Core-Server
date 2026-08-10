# Satpuda Core Server

Multi-store pharmacy API replacing Firebase for **Mac2** + **Satpuda Core Android**.

| | |
|--|--|
| **GitHub** | https://github.com/roshanghogale/Satpuda-Core-Server.git |
| **VPS IP** | `200.234.32.222` |
| **Stack** | Node.js 20 + Express + PostgreSQL 16/17/18 (no Docker required) |
| **Tunnel** | Cloudflare Tunnel → your domain → this API |

---

## Schema coverage (SQLite / Firebase parity)

### Core (synced like Firebase)
customers, suppliers, doctors, medicines, sales (+items), purchases (+items),  
customer_payments, supplier_payments, sales_returns (+items), purchase_returns (+items),  
pharmacy_profile, dropdowns (villages, med_types, schedules)

### Extra (Mac2 / Android local tables now on server)
general_products, stock_disposals, pending_orders,  
racks, sections, boxes, shelves, medicine_shelf, shelf_settings,  
medicine_suppliers, medicines_master, store_settings (KV)

### Platform
stores, store_devices, admins, fy_serials, sync_watermarks, audit_log

---

## Sync API (create / update / delete)

All store routes need: `Authorization: Bearer <store-jwt>`

| Method | Path | Action |
|--------|------|--------|
| POST | `/api/auth/pair` | Pair with `SC-XXXXXXXX` key |
| POST | `/api/sync/:collection` | Upsert docs (create/update) |
| POST | `/api/sync/bundle` | Multi-collection transaction |
| GET | `/api/sync/:collection?since=` | Incremental pull |
| GET | `/api/sync` | Full pull |
| DELETE | `/api/sync/:collection/:id` | Soft-delete |
| POST | `/api/sync/fy/allocate` | Next FY bill/purchase no |
| PUT/GET | `/api/sync/settings/*` | profile, dropdowns, shelf, kv |

Conflict rules: higher `version` → newer `updated_at` → `device_id`.

---

## VPS setup (no Docker) + Cloudflare Tunnel

### 1. On VPS — install Node + PostgreSQL
```bash
ssh root@200.234.32.222

# Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# PostgreSQL (Ubuntu)
apt-get install -y postgresql postgresql-contrib
sudo -u postgres psql -c "CREATE USER satpuda WITH PASSWORD 'CHANGE_STRONG_PASSWORD';"
sudo -u postgres psql -c "CREATE DATABASE satpuda_core OWNER satpuda;"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE satpuda_core TO satpuda;"
```

### 2. Clone from GitHub
```bash
cd /opt
git clone https://github.com/roshanghogale/Satpuda-Core-Server.git
cd Satpuda-Core-Server
cp .env.example .env
# edit DATABASE_URL, JWT_SECRET, ADMIN_PASSWORD
nano .env

npm install
cd admin && npm install && npm run build && cd ..
npm run db:migrate
npm run db:seed
```

### 3. Run with systemd
```bash
cat >/etc/systemd/system/satpuda.service <<'EOF'
[Unit]
Description=Satpuda Core Server
After=network.target postgresql.service

[Service]
Type=simple
WorkingDirectory=/opt/Satpuda-Core-Server
ExecStart=/usr/bin/node src/index.js
Restart=always
Environment=NODE_ENV=production
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now satpuda
curl http://127.0.0.1:3000/api/health
```

### 4. Cloudflare Tunnel
```bash
# Install cloudflared, then:
cloudflared tunnel login
cloudflared tunnel create satpuda
cloudflared tunnel route dns satpuda api.yourdomain.com

# config.yml example:
# tunnel: <TUNNEL_ID>
# credentials-file: /root/.cloudflared/<TUNNEL_ID>.json
# ingress:
#   - hostname: api.yourdomain.com
#     service: http://127.0.0.1:3000
#   - service: http_status:404

cloudflared tunnel run satpuda
```

Admin UI: `https://api.yourdomain.com/admin/`  
API: `https://api.yourdomain.com/api/health`

---

## Local Windows (dev)

1. Install [PostgreSQL 18](https://www.postgresql.org/download/windows/) (set a password you remember)
2. Create DB:
```sql
CREATE USER satpuda WITH PASSWORD 'satpuda_dev';
CREATE DATABASE satpuda_core OWNER satpuda;
```
3. Copy `.env.example` → `.env` and set `DATABASE_URL`
4. `npm install && npm run db:migrate && npm run db:seed && npm start`

---

## Admin

- Login: `/admin/` with `ADMIN_USERNAME` / `ADMIN_PASSWORD` from `.env`
- Create stores → share `SC-…` pairing keys with Mac2 / Android
