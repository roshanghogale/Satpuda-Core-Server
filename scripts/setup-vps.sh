#!/usr/bin/env bash
# Native VPS setup (NO Docker) for Satpuda Core Server
# Run on: 200.234.32.222  after: git clone https://github.com/roshanghogale/Satpuda-Core-Server.git
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/Satpuda-Core-Server}"
DB_PASS="${DB_PASS:-$(openssl rand -hex 16)}"
JWT="$(openssl rand -hex 32)"
ADMIN_PASS="${ADMIN_PASS:-$(openssl rand -hex 8)}"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg postgresql postgresql-contrib

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='satpuda'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE USER satpuda WITH PASSWORD '$DB_PASS';"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='satpuda_core'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE DATABASE satpuda_core OWNER satpuda;"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE satpuda_core TO satpuda;"
# PG15+ schema grant
sudo -u postgres psql -d satpuda_core -c "GRANT ALL ON SCHEMA public TO satpuda;" || true

cd "$APP_DIR"
if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s|CHANGE_ME_STRONG_PASSWORD|$DB_PASS|" .env
  sed -i "s|CHANGE_ME_LONG_RANDOM_SECRET_64_CHARS_MIN|$JWT|" .env
  sed -i "s|CHANGE_ME_ADMIN_PASSWORD|$ADMIN_PASS|" .env
  echo "Saved credentials:"
  echo "  DB password:    $DB_PASS"
  echo "  Admin password: $ADMIN_PASS"
fi

npm install
(cd admin && npm install && npm run build)
npm run db:migrate
npm run db:seed

cat >/etc/systemd/system/satpuda.service <<EOF
[Unit]
Description=Satpuda Core Server
After=network.target postgresql.service

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node src/index.js
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now satpuda
sleep 2
curl -fsS http://127.0.0.1:3000/api/health || true
echo "Done. Point Cloudflare Tunnel to http://127.0.0.1:3000"
echo "Admin: http://200.234.32.222:3000/admin/  (or your CF domain)"
