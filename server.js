// ============================================================
// server.js v2 — 오늘의 참견 / 인스타툰 / 애니메이션 공용 Railway 프록시
// 추가: 통계 트래킹 시스템 (IP 기반 방문자 + 생성 카운트, JSON 파일 저장)
// by 제일라 · GitHub: Zhei-la
// ============================================================

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(cors());

// trust proxy (Railway는 프록시 뒤에 있어서 실제 IP 받으려면 필요)
app.set('trust proxy', true);

const OPENAI_API = 'https://api.openai.com/v1/chat/completions';

// ============================================================
// 통계 저장소 — Railway 볼륨에 JSON 파일로
// ============================================================
// Railway 볼륨 경로: /data (Railway 대시보드에서 볼륨 마운트 필요)
// 볼륨 없으면 /tmp에 저장 (재시작 시 사라지지만 동작은 함)
const DATA_DIR = fs.existsSync('/data') ? '/data' : '/tmp';
const STATS_FILE = path.join(DATA_DIR, 'usage_stats.json');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'zheila2026'; // 환경변수로 덮어쓰기 권장

function defaultStats() {
  return {
    apps: {},
    createdAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
  };
}

let stats;
try {
  if (fs.existsSync(STATS_FILE)) {
    stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    console.log(`📊 Loaded existing stats from ${STATS_FILE}`);
  } else {
    stats = defaultStats();
    console.log(`📊 Created new stats at ${STATS_FILE}`);
  }
} catch (e) {
  console.error('stats load error:', e);
  stats = defaultStats();
}

// 디바운싱 저장 (잦은 쓰기 방지)
let saveTimer = null;
function persistStats() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      stats.lastUpdated = new Date().toISOString();
      fs.writeFileSync(STATS_FILE, JSON.stringify(stats), 'utf8');
    } catch (e) {
      console.error('stats save error:', e);
    }
  }, 1000);
}

function ensureApp(appId, name) {
  if (!stats.apps[appId]) {
    stats.apps[appId] = {
      name: name || appId,
      totalVisits: 0,
      totalGenerates: 0,
      daily: {},
      allIps: [],
    };
  } else if (name) {
    stats.apps[appId].name = name;
  }
  return stats.apps[appId];
}

function ensureDaily(app, dateKey) {
  if (!app.daily[dateKey]) {
    app.daily[dateKey] = { visits: 0, generates: 0, ips: [] };
  }
  return app.daily[dateKey];
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.ip || 'unknown';
}

function todayKey() {
  return new Date().toISOString().split('T')[0];
}

// ============================================================
// Health check
// ============================================================
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'angry-prompt-server',
    endpoints: ['/openai/chat', '/openai/scene', '/openai/research', '/track/visit', '/track/generate', '/admin/stats'],
    features: { vision: true, tracking: true },
    storage: DATA_DIR,
    apps_tracked: Object.keys(stats.apps).length,
  });
});

// ============================================================
// /track/visit
// ============================================================
app.post('/track/visit', (req, res) => {
  try {
    const { appId, name } = req.body || {};
    if (!appId) return res.status(400).json({ error: 'appId 필요' });

    const ip = getClientIp(req);
    const today = todayKey();
    const app = ensureApp(appId, name);
    const day = ensureDaily(app, today);

    app.totalVisits += 1;
    day.visits += 1;
    if (!day.ips.includes(ip)) day.ips.push(ip);
    if (!app.allIps.includes(ip)) app.allIps.push(ip);

    persistStats();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// /track/generate
// ============================================================
app.post('/track/generate', (req, res) => {
  try {
    const { appId, name } = req.body || {};
    if (!appId) return res.status(400).json({ error: 'appId 필요' });

    const ip = getClientIp(req);
    const today = todayKey();
    const app = ensureApp(appId, name);
    const day = ensureDaily(app, today);

    app.totalGenerates += 1;
    day.generates += 1;
    if (!day.ips.includes(ip)) day.ips.push(ip);
    if (!app.allIps.includes(ip)) app.allIps.push(ip);

    persistStats();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// /admin/stats — 통계 조회 (관리자 전용, 토큰 필요)
// ============================================================
app.get('/admin/stats', (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: '인증 실패' });
  }

  try {
    const today = todayKey();
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    const dateRange = (days) => {
      const arr = [];
      for (let i = 0; i < days; i++) {
        arr.push(new Date(Date.now() - i * 86400000).toISOString().split('T')[0]);
      }
      return arr;
    };

    const last7days = dateRange(7);
    const last30days = dateRange(30);

    let grandVisits = 0, grandGenerates = 0;
    const allIpsGlobal = new Set();

    const apps = Object.entries(stats.apps).map(([appId, a]) => {
      grandVisits += a.totalVisits;
      grandGenerates += a.totalGenerates;
      a.allIps.forEach(ip => allIpsGlobal.add(ip));

      const sumRange = (days) => {
        let v = 0, g = 0; const ips = new Set();
        days.forEach(d => {
          const day = a.daily[d];
          if (day) { v += day.visits; g += day.generates; day.ips.forEach(ip => ips.add(ip)); }
        });
        return { visits: v, generates: g, uniqueVisitors: ips.size };
      };

      return {
        appId,
        name: a.name,
        totalVisits: a.totalVisits,
        totalGenerates: a.totalGenerates,
        uniqueVisitors: a.allIps.length,
        today: sumRange([today]),
        yesterday: sumRange([yesterday]),
        last7: sumRange(last7days),
        last30: sumRange(last30days),
      };
    });

    const dailyChart = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
      let v = 0, g = 0; const ips = new Set();
      Object.values(stats.apps).forEach(a => {
        const day = a.daily[d];
        if (day) { v += day.visits; g += day.generates; day.ips.forEach(ip => ips.add(ip)); }
      });
      dailyChart.push({ date: d, visits: v, generates: g, uniqueVisitors: ips.size });
    }

    res.json({
      summary: {
        totalApps: apps.length,
        totalVisits: grandVisits,
        totalGenerates: grandGenerates,
        totalUniqueVisitors: allIpsGlobal.size,
        lastUpdated: stats.lastUpdated,
        createdAt: stats.createdAt,
      },
      apps,
      dailyChart,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// /admin/reset — 통계 초기화 (관리자 전용)
// ============================================================
app.post('/admin/reset', (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: '인증 실패' });
  stats = defaultStats();
  persistStats();
  res.json({ ok: true });
});

// ============================================================
// /openai/chat — vision 지원
// ============================================================
app.post('/openai/chat', async (req, res) => {
  try {
    const {
      apiKey, system, user, image, vision, model,
      max_tokens = 900, temperature = 0.8, response_format
    } = req.body || {};

    if (!apiKey) return res.status(400).json({ error: 'apiKey 필요' });
    if (!system && !user) return res.status(400).json({ error: 'system 또는 user 필요' });

    const isVision = !!(image || vision);
    const useModel = model || (isVision ? 'gpt-4o' : 'gpt-4o-mini');

    let userContent;
    if (isVision && image) {
      const dataUrl = image.startsWith('data:') ? image : `data:image/jpeg;base64,${image}`;
      userContent = [
        { type: 'text', text: user || 'Analyze this image.' },
        { type: 'image_url', image_url: { url: dataUrl } }
      ];
    } else {
      userContent = user || '';
    }

    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: userContent });

    const payload = { model: useModel, messages, max_tokens, temperature };
    if (response_format) payload.response_format = response_format;

    const openaiRes = await fetch(OPENAI_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(payload)
    });

    const data = await openaiRes.json();
    if (!openaiRes.ok) {
      console.error('[openai/chat] OpenAI error:', data);
      return res.status(openaiRes.status).json({ error: data.error?.message || 'OpenAI API error', raw: data });
    }

    const content = data.choices?.[0]?.message?.content || '';
    return res.json({ content, model: useModel, vision: isVision, usage: data.usage });
  } catch (err) {
    console.error('[openai/chat] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// /openai/scene
// ============================================================
app.post('/openai/scene', async (req, res) => {
  try {
    const { apiKey, object, concept } = req.body || {};
    if (!apiKey) return res.status(400).json({ error: 'apiKey 필요' });
    if (!object) return res.status(400).json({ error: 'object 필요' });

    const system = `You are a scene designer for AI short-form video prompts. Given an everyday object and a concept, output a natural setting for this object.
Return STRICT JSON only:
{
  "loc": "<natural location in English>",
  "props": "<1-3 supporting props in English, comma-separated>",
  "ambient": "<lighting/mood description in English>",
  "motion": "<subtle background motion description in English>"
}`;
    const user = `Object: ${object}\nConcept: ${concept || 'general'}`;

    const openaiRes = await fetch(OPENAI_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        max_tokens: 300, temperature: 0.8,
        response_format: { type: 'json_object' }
      })
    });

    const data = await openaiRes.json();
    if (!openaiRes.ok) return res.status(openaiRes.status).json({ error: data.error?.message || 'OpenAI API error' });
    const content = data.choices?.[0]?.message?.content || '{}';
    let parsed = {};
    try { parsed = JSON.parse(content); } catch(_) {}
    return res.json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// /openai/research
// ============================================================
app.post('/openai/research', async (req, res) => {
  try {
    const { apiKey, query } = req.body || {};
    if (!apiKey) return res.status(400).json({ error: 'apiKey 필요' });

    const system = '너는 리서처다. 주제에 대한 사실 기반 정보를 3~5 문장으로 요약해서 한국어로 출력.';
    const openaiRes = await fetch(OPENAI_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: system }, { role: 'user', content: query || '' }],
        max_tokens: 400, temperature: 0.5
      })
    });
    const data = await openaiRes.json();
    if (!openaiRes.ok) return res.status(openaiRes.status).json({ error: data.error?.message || 'OpenAI API error' });
    return res.json({ content: data.choices?.[0]?.message?.content || '' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Start
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 angry-prompt-server v2 listening on :${PORT}`);
  console.log(`   · vision enabled (gpt-4o)`);
  console.log(`   · tracking enabled (storage: ${DATA_DIR})`);
  console.log(`   · admin token: ${ADMIN_TOKEN === 'zheila2026' ? '⚠️ DEFAULT (env: ADMIN_TOKEN)' : '✅ custom'}`);
});
