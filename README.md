# Value Site

Public page: `/`   Admin panel: `/admin.html`

## Environment variables (set these on your host)
- `DATABASE_URL`  - Postgres connection string (see below)
- `ADMIN_PASSWORD` - whatever password you want for the admin panel

## Why your data survives deploys
All data lives in an external Postgres database, NOT on the server's disk.
Deploys only replace the code. The table is created with CREATE TABLE IF NOT EXISTS,
so it never wipes anything. Nothing is seeded.

## Setup
1. Make a free Postgres DB at neon.tech (or supabase.com). Copy the connection string.
2. Push this folder to GitHub.
3. On Render / Railway: new Web Service from the repo.
   Build: `npm install`   Start: `npm start`
   Add env vars DATABASE_URL and ADMIN_PASSWORD.
4. Open `yoursite/admin.html`, log in, add items.

## Backups
Admin panel has "Download backup" and "Restore from backup". Download one now and then.

## Updating from the previous version
Just redeploy. On startup the server runs `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
for the new Demand and Trend columns, so your existing items stay exactly as they are.
