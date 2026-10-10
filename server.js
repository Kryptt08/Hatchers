const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!DATABASE_URL || !ADMIN_PASSWORD) {
  console.error('Missing DATABASE_URL or ADMIN_PASSWORD environment variable.');
  process.exit(1);
}

const isLocal = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Creates the table ONLY if it doesn't exist. Never drops or wipes anything.
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('legend','secret')),
      image_url TEXT NOT NULL DEFAULT '',
      v_normal DOUBLE PRECISION NOT NULL DEFAULT 0,
      v_shiny DOUBLE PRECISION NOT NULL DEFAULT 0,
      v_mystic DOUBLE PRECISION NOT NULL DEFAULT 0,
      v_shiny_mystic DOUBLE PRECISION NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (name, category)
    )
  `);
  // Safe migration: adds new columns to an existing table, keeps all data
  await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS demand TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS trend TEXT NOT NULL DEFAULT ''`);
  for (const c of ['e_normal', 'e_shiny', 'e_mystic', 'e_shiny_mystic']) {
    await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS ${c} DOUBLE PRECISION NOT NULL DEFAULT 0`);
  }
}

// "1.5b" -> 1500000000, "250k" -> 250000, "1,000" -> 1000
function parseValue(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  const m = String(v).trim().replace(/,/g, '').match(/^(\d*\.?\d+)\s*([kmbt])?$/i);
  if (!m) return 0;
  const mult = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[(m[2] || '').toLowerCase()] || 1;
  return parseFloat(m[1]) * mult;
}

function auth(req, res, next) {
  const given = Buffer.from(String(req.get('x-admin-password') || ''));
  const real = Buffer.from(ADMIN_PASSWORD);
  if (given.length === real.length && crypto.timingSafeEqual(given, real)) return next();
  res.status(401).json({ error: 'Wrong password' });
}

const DEMANDS = ['low', 'medium', 'high', 'very high'];
const TRENDS = ['rising', 'stable', 'falling'];

function clean(b) {
  const demand = String(b.demand || '').trim().toLowerCase();
  const trend = String(b.trend || '').trim().toLowerCase();
  const isSecret = b.category === 'secret';
  const ex = k => (isSecret ? Math.max(0, Math.round(parseValue(b[k]))) : 0); // exist counts: secrets only
  return {
    demand: DEMANDS.includes(demand) ? demand : '',
    trend: TRENDS.includes(trend) ? trend : '',
    name: String(b.name || '').trim(),
    category: b.category === 'secret' ? 'secret' : 'legend',
    image_url: String(b.image_url || '').trim(),
    v_normal: parseValue(b.v_normal),
    v_shiny: parseValue(b.v_shiny),
    v_mystic: parseValue(b.v_mystic),
    v_shiny_mystic: parseValue(b.v_shiny_mystic),
    notes: String(b.notes || '').trim(),
    e_normal: ex('e_normal'),
    e_shiny: ex('e_shiny'),
    e_mystic: ex('e_mystic'),
    e_shiny_mystic: ex('e_shiny_mystic'),
  };
}

const wrap = fn => (req, res) => fn(req, res).catch(e => {
  console.error(e);
  res.status(500).json({ error: e.code === '23505' ? 'That item already exists in that category' : 'Server error' });
});

// ---------- public ----------
app.get('/api/items', wrap(async (req, res) => {
  const r = await pool.query('SELECT * FROM items ORDER BY name');
  res.json(r.rows);
}));

// ---------- admin ----------
app.post('/api/login', auth, (req, res) => res.json({ ok: true }));

app.post('/api/items', auth, wrap(async (req, res) => {
  const d = clean(req.body);
  if (!d.name) return res.status(400).json({ error: 'Name required' });
  const r = await pool.query(
    `INSERT INTO items (name,category,image_url,v_normal,v_shiny,v_mystic,v_shiny_mystic,notes,demand,trend,e_normal,e_shiny,e_mystic,e_shiny_mystic)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [d.name, d.category, d.image_url, d.v_normal, d.v_shiny, d.v_mystic, d.v_shiny_mystic, d.notes, d.demand, d.trend, d.e_normal, d.e_shiny, d.e_mystic, d.e_shiny_mystic]);
  res.json(r.rows[0]);
}));

app.put('/api/items/:id', auth, wrap(async (req, res) => {
  const d = clean(req.body);
  if (!d.name) return res.status(400).json({ error: 'Name required' });
  const r = await pool.query(
    `UPDATE items SET name=$1,category=$2,image_url=$3,v_normal=$4,v_shiny=$5,v_mystic=$6,
     v_shiny_mystic=$7,notes=$8,demand=$9,trend=$10,e_normal=$11,e_shiny=$12,e_mystic=$13,e_shiny_mystic=$14,updated_at=now() WHERE id=$15 RETURNING *`,
    [d.name, d.category, d.image_url, d.v_normal, d.v_shiny, d.v_mystic, d.v_shiny_mystic, d.notes, d.demand, d.trend, d.e_normal, d.e_shiny, d.e_mystic, d.e_shiny_mystic, req.params.id]);
  res.json(r.rows[0] || {});
}));

app.delete('/api/items/:id', auth, wrap(async (req, res) => {
  await pool.query('DELETE FROM items WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// Backup download
app.get('/api/export', auth, wrap(async (req, res) => {
  const r = await pool.query('SELECT name,category,image_url,v_normal,v_shiny,v_mystic,v_shiny_mystic,notes,demand,trend,e_normal,e_shiny,e_mystic,e_shiny_mystic FROM items ORDER BY name');
  res.setHeader('Content-Disposition', 'attachment; filename="values-backup.json"');
  res.json(r.rows);
}));

// Restore / bulk import (adds new, updates existing by name+category, never deletes)
app.post('/api/import', auth, wrap(async (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Expected a JSON array' });
  let n = 0;
  for (const raw of req.body) {
    const d = clean(raw);
    if (!d.name) continue;
    await pool.query(
      `INSERT INTO items (name,category,image_url,v_normal,v_shiny,v_mystic,v_shiny_mystic,notes,demand,trend,e_normal,e_shiny,e_mystic,e_shiny_mystic)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (name,category) DO UPDATE SET image_url=EXCLUDED.image_url,
       v_normal=EXCLUDED.v_normal, v_shiny=EXCLUDED.v_shiny, v_mystic=EXCLUDED.v_mystic,
       v_shiny_mystic=EXCLUDED.v_shiny_mystic, notes=EXCLUDED.notes,
       demand=EXCLUDED.demand, trend=EXCLUDED.trend,
       e_normal=EXCLUDED.e_normal, e_shiny=EXCLUDED.e_shiny, e_mystic=EXCLUDED.e_mystic,
       e_shiny_mystic=EXCLUDED.e_shiny_mystic, updated_at=now()`,
      [d.name, d.category, d.image_url, d.v_normal, d.v_shiny, d.v_mystic, d.v_shiny_mystic, d.notes, d.demand, d.trend, d.e_normal, d.e_shiny, d.e_mystic, d.e_shiny_mystic]);
    n++;
  }
  res.json({ imported: n });
}));

init()
  .then(() => app.listen(process.env.PORT || 3000, () => console.log('Running')))
  .catch(e => { console.error('DB init failed', e); process.exit(1); });
