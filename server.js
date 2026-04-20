require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// DB 연결
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// DB 초기화
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stats (
      id SERIAL PRIMARY KEY,
      type VARCHAR(50),
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS codes (
      id SERIAL PRIMARY KEY,
      code VARCHAR(100) UNIQUE,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  // 기본 접속 코드 없으면 삽입
  const existing = await pool.query('SELECT * FROM codes');
  if (existing.rows.length === 0) {
    await pool.query(`INSERT INTO codes (code) VALUES ($1)`, [process.env.ACCESS_CODE || 'angry2024']);
  }
}

// ── 접속 코드 검증 ──────────────────────────────────────
app.post('/verify', async (req, res) => {
  const { code } = req.body;
  const result = await pool.query(
    'SELECT * FROM codes WHERE code=$1 AND is_active=true', [code]
  );
  if (result.rows.length > 0) {
    await pool.query(`INSERT INTO stats (type) VALUES ('access')`);
    res.json({ ok: true });
  } else {
    res.json({ ok: false });
  }
});

// ── 관리자 인증 ──────────────────────────────────────────
app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    res.json({ ok: true });
  } else {
    res.json({ ok: false });
  }
});

// ── 사용 횟수 기록 ───────────────────────────────────────
app.post('/stats/record', async (req, res) => {
  const { type } = req.body;
  await pool.query(`INSERT INTO stats (type) VALUES ($1)`, [type || 'generate']);
  res.json({ ok: true });
});

// ── 통계 조회 (관리자) ───────────────────────────────────
app.post('/admin/stats', async (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) return res.json({ ok: false });

  const total = await pool.query(`SELECT COUNT(*) FROM stats WHERE type='access'`);
  const generates = await pool.query(`SELECT COUNT(*) FROM stats WHERE type='generate'`);
  const today = await pool.query(`SELECT COUNT(*) FROM stats WHERE type='access' AND created_at >= CURRENT_DATE`);
  const codes = await pool.query(`SELECT * FROM codes ORDER BY created_at DESC`);

  res.json({
    ok: true,
    stats: {
      totalVisits: total.rows[0].count,
      todayVisits: today.rows[0].count,
      totalGenerates: generates.rows[0].count,
      codes: codes.rows
    }
  });
});

// ── 코드 관리 (관리자) ───────────────────────────────────
app.post('/admin/codes/add', async (req, res) => {
  const { password, code } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) return res.json({ ok: false });
  await pool.query(`INSERT INTO codes (code) VALUES ($1) ON CONFLICT DO NOTHING`, [code]);
  res.json({ ok: true });
});

app.post('/admin/codes/toggle', async (req, res) => {
  const { password, code } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) return res.json({ ok: false });
  await pool.query(`UPDATE codes SET is_active = NOT is_active WHERE code=$1`, [code]);
  res.json({ ok: true });
});

// ── 헬스체크 ─────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`서버 실행 중: ${PORT}`));
});