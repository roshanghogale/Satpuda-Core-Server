# Install PostgreSQL on Windows (required once)

Automated install from this environment failed (needs Administrator).

## Option A — Official installer (recommended)

1. Download PostgreSQL **18** (latest): https://www.postgresql.org/download/windows/
2. Run installer as Administrator
3. Remember the password you set for user `postgres`
4. Keep port `5432`
5. After install, open **SQL Shell (psql)** or PowerShell:

```sql
CREATE USER satpuda WITH PASSWORD 'satpuda_dev';
CREATE DATABASE satpuda_core OWNER satpuda;
GRANT ALL PRIVILEGES ON DATABASE satpuda_core TO satpuda;
\c satpuda_core
GRANT ALL ON SCHEMA public TO satpuda;
```

6. In `server/.env`:
```
DATABASE_URL=postgresql://satpuda:satpuda_dev@127.0.0.1:5432/satpuda_core
```

7. Then:
```powershell
cd "D:\Satpuda Core Server Update\server"
npm run db:migrate
npm run db:seed
npm run db:verify
npm start
```

## Option B — Admin PowerShell + Chocolatey

```powershell
# Run PowerShell as Administrator
choco install postgresql18 --params '/Password:YOUR_POSTGRES_PASSWORD' -y
```

## VPS note

On Hostinger (`200.234.32.222`) install Postgres with apt — see `scripts/setup-vps.sh`. You do **not** need Postgres on this Windows PC to deploy the VPS.
