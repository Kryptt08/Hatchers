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

// Every column the admin can edit (used to build all the SQL below)
const COLS = [
  'name', 'category', 'image_url',
  'v_normal', 'v_shiny', 'v_mystic', 'v_shiny_mystic',
  'vt_normal', 'vt_shiny', 'vt_mystic', 'vt_shiny_mystic',
  'notes', 'demand', 'trend',
  'e_normal', 'e_shiny', 'e_mystic', 'e_shiny_mystic',
  'subcat',
];

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
  // Safe migrations: add new columns, keep all existing data
  const add = [
    ['demand', "TEXT NOT NULL DEFAULT ''"],
    ['trend', "TEXT NOT NULL DEFAULT ''"],
    ['e_normal', 'DOUBLE PRECISION NOT NULL DEFAULT 0'],
    ['e_shiny', 'DOUBLE PRECISION NOT NULL DEFAULT 0'],
    ['e_mystic', 'DOUBLE PRECISION NOT NULL DEFAULT 0'],
    ['e_shiny_mystic', 'DOUBLE PRECISION NOT NULL DEFAULT 0'],
    ['vt_normal', "TEXT NOT NULL DEFAULT ''"],
    ['vt_shiny', "TEXT NOT NULL DEFAULT ''"],
    ['vt_mystic', "TEXT NOT NULL DEFAULT ''"],
    ['vt_shiny_mystic', "TEXT NOT NULL DEFAULT ''"],
    ['subcat', "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [c, t] of add) {
    await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS ${c} ${t}`);
  }
}

// "1.5b" -> 1500000000, "250k" -> 250000, "1,000" -> 1000
function parseNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  const m = String(v).trim().replace(/,/g, '').match(/^(\d*\.?\d+)\s*([kmbt])?$/i);
  if (!m) return 0;
  const mult = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[(m[2] || '').toLowerCase()] || 1;
  return parseFloat(m[1]) * mult;
}

// A value slot can be a number ("1.5b") OR free text ("N/A", "Offsale")
function parseVal(v) {
  if (v === null || v === undefined) return { n: 0, t: '' };
  if (typeof v === 'number') return { n: isFinite(v) ? v : 0, t: '' };
  const s = String(v).trim();
  if (!s) return { n: 0, t: '' };
  if (/^(\d*\.?\d+)\s*([kmbt])?$/i.test(s.replace(/,/g, ''))) return { n: parseNum(s), t: '' };
  return { n: 0, t: s.slice(0, 30) };
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
  const category = b.category === 'secret' ? 'secret' : 'legend';
  const isSecret = category === 'secret';
  const demand = String(b.demand || '').trim().toLowerCase();
  const trend = String(b.trend || '').trim().toLowerCase();
  // exist counts and subcategory are for secrets only
  const ex = k => (isSecret ? Math.max(0, Math.round(parseNum(b[k]))) : 0);
  // text version wins if present (that's how backups store text values)
  const pv = k => parseVal(b['vt_' + k] ? b['vt_' + k] : b['v_' + k]);
  const n = pv('normal'), s = pv('shiny'), m = pv('mystic'), sm = pv('shiny_mystic');
  return {
    name: String(b.name || '').trim(),
    category,
    image_url: String(b.image_url || '').trim(),
    v_normal: n.n, v_shiny: s.n, v_mystic: m.n, v_shiny_mystic: sm.n,
    vt_normal: n.t, vt_shiny: s.t, vt_mystic: m.t, vt_shiny_mystic: sm.t,
    notes: String(b.notes || '').trim(),
    demand: DEMANDS.includes(demand) ? demand : '',
    trend: TRENDS.includes(trend) ? trend : '',
    e_normal: ex('e_normal'), e_shiny: ex('e_shiny'), e_mystic: ex('e_mystic'), e_shiny_mystic: ex('e_shiny_mystic'),
    subcat: isSecret ? String(b.subcat || '').trim().toLowerCase().slice(0, 30) : '',
  };
}

const wrap = fn => (req, res) => fn(req, res).catch(e => {
  console.error(e);
  res.status(500).json({ error: e.code === '23505' ? 'That item already exists in that category' : 'Server error' });
});

const INSERT_SQL = `INSERT INTO items (${COLS.join(',')}) VALUES (${COLS.map((_, i) => '$' + (i + 1)).join(',')})`;
const UPDATE_SQL = `UPDATE items SET ${COLS.map((c, i) => `${c}=$${i + 1}`).join(',')},updated_at=now() WHERE id=$${COLS.length + 1} RETURNING *`;
const UPSERT_SQL = INSERT_SQL +
  ` ON CONFLICT (name,category) DO UPDATE SET ` +
  COLS.filter(c => c !== 'name' && c !== 'category').map(c => `${c}=EXCLUDED.${c}`).join(',') +
  `,updated_at=now()`;

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
  const r = await pool.query(INSERT_SQL + ' RETURNING *', COLS.map(c => d[c]));
  res.json(r.rows[0]);
}));

app.put('/api/items/:id', auth, wrap(async (req, res) => {
  const d = clean(req.body);
  if (!d.name) return res.status(400).json({ error: 'Name required' });
  const r = await pool.query(UPDATE_SQL, [...COLS.map(c => d[c]), req.params.id]);
  res.json(r.rows[0] || {});
}));

app.delete('/api/items/:id', auth, wrap(async (req, res) => {
  await pool.query('DELETE FROM items WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// Backup download
app.get('/api/export', auth, wrap(async (req, res) => {
  const r = await pool.query(`SELECT ${COLS.join(',')} FROM items ORDER BY name`);
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
    await pool.query(UPSERT_SQL, COLS.map(c => d[c]));
    n++;
  }
  res.json({ imported: n });
}));

init()
  .then(() => app.listen(process.env.PORT || 3000, () => console.log('Running')))
  .catch(e => { console.error('DB init failed', e); process.exit(1); });
