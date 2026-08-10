#!/usr/bin/env bash
# Deploy Satpuda Core Server on Ubuntu/Hostinger VPS
# Usage: bash scripts/deploy.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/satpuda-core}"
DOMAIN_OR_IP="${DOMAIN_OR_IP:-200.234.32.222}"

echo "==> Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg ufw nginx

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

if ! command -v psql >/dev/null 2>&1; then
  apt-get install -y postgresql postgresql-contrib
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi

echo "==> Preparing app directory $APP_DIR"
mkdir -p "$APP_DIR"
# Expect this script to be run from the server/ folder after files are uploaded
cp -a . "$APP_DIR/" 2>/dev/null || true
cd "$APP_DIR"

if [ ! -f .env ]; then
  cp .env.example .env
  # Generate secrets
  JWT=$(openssl rand -hex 32)
  PG_PASS=$(openssl rand -hex 16)
  ADMIN_PASS=$(openssl rand -hex 8)
  sed -i "s|CHANGE_ME_LONG_RANDOM_SECRET_64_CHARS_MIN|$JWT|" .env
  sed -i "s|CHANGE_ME_STRONG_PASSWORD|$PG_PASS|" .env
  sed -i "s|CHANGE_ME_ADMIN_PASSWORD|$ADMIN_PASS|" .env
  sed -i "s|POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$PG_PASS|" .env || true
  echo "POSTGRES_PASSWORD=$PG_PASS" >> .env
  echo ""
  echo "============================================"
  echo "Generated credentials (SAVE THESE):"
  echo "  Admin user:     admin"
  echo "  Admin password: $ADMIN_PASS"
  echo "  DB password:    $PG_PASS"
  echo "  Dashboard:      http://$DOMAIN_OR_IP/admin/"
  echo "============================================"
fi

echo "==> Starting Docker stack"
docker compose up -d --build

echo "==> Configuring Nginx reverse proxy"
cat >/etc/nginx/sites-available/satpuda <<NGINX
server {
    listen 80;
    server_name $DOMAIN_OR_IP;

    client_max_body_size 30m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/satpuda /etc/nginx/sites-enabled/satpuda
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

ufw allow OpenSSH || true
ufw allow 80/tcp || true
ufw allow 443/tcp || true
ufw --force enable || true

echo "==> Waiting for API health"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:3000/api/health" >/dev/null; then
    echo "API is healthy"
    break
  fi
  sleep 2
done

echo "Deploy complete → http://$DOMAIN_OR_IP/admin/"
