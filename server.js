// ============================================================
// server.js v3 — 안전 강화판
// Railway 배포 실패 방어: 모든 I/O try-catch, 권한 에러 무시, 메모리 fallback
// by 제일라 · GitHub: Zhei-la
// ============================================================

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(cors());
app.set('trust proxy', true);

const OPENAI_API = 'https://api.openai.com/v1/chat/completions';

// ============================================================
// 글로벌 에러 핸들러 — 어떤 예외도 서버 죽이지 않음
// ============================================================
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

// ============================================================
// 통계 저장소 — 안전하게 초기화
// ============================================================
let DATA_DIR = '/tmp';
try {
  if (fs.existsSync('/data')) {
    const testFile = '/data/.write_test';
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
    DATA_DIR = '/data';
    console.log('📦 Using /data volume for persistence');
  } else {
    console.log('📦 /data volume not mounted, using /tmp (stats will reset on restart)');
  }
} catch (e) {
  console.log('📦 /data not writable, falling back to /tmp:', e.message);
  DATA_DIR = '/tmp';
}

const STATS_FILE = path.join(DATA_DIR, 'usage_stats.json');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'zheila2026';

function defaultStats() {
  return {
    apps: {},
    createdAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
  };
}

let stats = defaultStats();

try {
  if (fs.existsSync(STATS_FILE)) {
    const raw = fs.readFileSync(STATS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.apps) {
      stats = parsed;
      console.log('📊 Loaded ' + Object.keys(stats.apps).length + ' apps from ' + STATS_FILE);
    }
  } else {
    console.log('📊 No existing stats file — starting fresh');
  }
} catch (e) {
  console.error('📊 stats load error (using defaults):', e.message);
  stats = defaultStats();
}

let saveTimer = null;
function persistStats() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(function() {
    try {
      stats.lastUpdated = new Date().toISOString();
      fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), 'utf8');
    } catch (e) {
      console.error('persistStats error:', e.message);
    }
  }, 1000);
}

// ============================================================
// 통계 유틸
// ============================================================
function getClientIp(req) {
  try {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
    return req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
  } catch (e) {
    return 'unknown';
  }
}

function todayKey() {
  return new Date().toISOString().split('T')[0];
}

function ensureApp(appId, name) {
  if (!stats.apps[appId]) {
    stats.apps[appId] = {
      id: appId,
      name: name || appId,
      totalVisits: 0,
      totalGenerates: 0,
      allIps: [],
      daily: {},
      firstSeen: new Date().toISOString(),
    };
  }
  if (name) stats.apps[appId].name = name;
  return stats.apps[appId];
}

function ensureDaily(appStat, dateKey) {
  if (!appStat.daily[dateKey]) {
    appStat.daily[dateKey] = { visits: 0, generates: 0, ips: [] };
  }
  return appStat.daily[dateKey];
}

// ============================================================
// Health check
// ============================================================
app.get('/', function(req, res) {
  try {
    res.json({
      ok: true,
      service: 'angry-prompt-server',
      version: 'v3',
      endpoints: ['/openai/chat', '/openai/scene', '/openai/research', '/track/visit', '/track/generate', '/admin/stats'],
      features: { vision: true, tracking: true },
      storage: DATA_DIR,
      apps_tracked: Object.keys(stats.apps).length,
    });
  } catch (e) {
    res.json({ ok: true, service: 'angry-prompt-server', version: 'v3' });
  }
});

// ============================================================
// /track/visit
// ============================================================
app.post('/track/visit', function(req, res) {
  try {
    const body = req.body || {};
    const appId = body.appId;
    const name = body.name;
    if (!appId) return res.status(400).json({ error: 'appId 필요' });

    const ip = getClientIp(req);
    const today = todayKey();
    const appStat = ensureApp(appId, name);
    const day = ensureDaily(appStat, today);

    appStat.totalVisits = (appStat.totalVisits || 0) + 1;
    day.visits = (day.visits || 0) + 1;
    if (day.ips.indexOf(ip) === -1) day.ips.push(ip);
    if (appStat.allIps.indexOf(ip) === -1) appStat.allIps.push(ip);

    persistStats();
    res.json({ ok: true });
  } catch (e) {
    console.error('[track/visit]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// /track/generate
// ============================================================
app.post('/track/generate', function(req, res) {
  try {
    const body = req.body || {};
    const appId = body.appId;
    const name = body.name;
    if (!appId) return res.status(400).json({ error: 'appId 필요' });

    const ip = getClientIp(req);
    const today = todayKey();
    const appStat = ensureApp(appId, name);
    const day = ensureDaily(appStat, today);

    appStat.totalGenerates = (appStat.totalGenerates || 0) + 1;
    day.generates = (day.generates || 0) + 1;
    if (day.ips.indexOf(ip) === -1) day.ips.push(ip);
    if (appStat.allIps.indexOf(ip) === -1) appStat.allIps.push(ip);

    persistStats();
    res.json({ ok: true });
  } catch (e) {
    console.error('[track/generate]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// /admin/stats — 통계 조회 (토큰 필요)
// ============================================================
app.get('/admin/stats', function(req, res) {
  try {
    const token = req.headers['x-admin-token'] || req.query.token;
    if (token !== ADMIN_TOKEN) {
      return res.status(401).json({ error: '인증 실패' });
    }

    const today = todayKey();
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    function dateRange(days) {
      const arr = [];
      for (let i = 0; i < days; i++) {
        arr.push(new Date(Date.now() - i * 86400000).toISOString().split('T')[0]);
      }
      return arr;
    }

    const days7 = dateRange(7);
    const days30 = dateRange(30);

    let totalVisits = 0;
    let totalGenerates = 0;
    const uniqueIpsGlobal = {};

    const appsArr = Object.keys(stats.apps).map(function(appId) {
      const appStat = stats.apps[appId];
      totalVisits += appStat.totalVisits || 0;
      totalGenerates += appStat.totalGenerates || 0;
      (appStat.allIps || []).forEach(function(ip) { uniqueIpsGlobal[ip] = true; });

      function sumRange(dates) {
        let v = 0, g = 0;
        const ips = {};
        dates.forEach(function(d) {
          const day = (appStat.daily || {})[d];
          if (!day) return;
          v += day.visits || 0;
          g += day.generates || 0;
          (day.ips || []).forEach(function(ip) { ips[ip] = true; });
        });
        return { visits: v, generates: g, uniqueIps: Object.keys(ips).length };
      }

      const todayStat = sumRange([today]);
      const yesterdayStat = sumRange([yesterday]);
      const week = sumRange(days7);
      const month = sumRange(days30);

      const trend30 = days30.slice().reverse().map(function(d) {
        const day = (appStat.daily || {})[d];
        return {
          date: d,
          visits: (day && day.visits) || 0,
          generates: (day && day.generates) || 0,
        };
      });

      return {
        id: appStat.id,
        name: appStat.name,
        totalVisits: appStat.totalVisits || 0,
        totalGenerates: appStat.totalGenerates || 0,
        uniqueIps: (appStat.allIps || []).length,
        today: todayStat,
        yesterday: yesterdayStat,
        week: week,
        month: month,
        trend30: trend30,
        firstSeen: appStat.firstSeen,
      };
    });

    const globalTrend = days30.slice().reverse().map(function(d) {
      let v = 0, g = 0;
      Object.keys(stats.apps).forEach(function(appId) {
        const appStat = stats.apps[appId];
        const day = (appStat.daily || {})[d];
        if (!day) return;
        v += day.visits || 0;
        g += day.generates || 0;
      });
      return { date: d, visits: v, generates: g };
    });

    res.json({
      ok: true,
      summary: {
        totalVisits: totalVisits,
        totalGenerates: totalGenerates,
        totalUniqueIps: Object.keys(uniqueIpsGlobal).length,
        totalApps: appsArr.length,
      },
      apps: appsArr.sort(function(a, b) { return b.totalGenerates - a.totalGenerates; }),
      globalTrend: globalTrend,
      storage: DATA_DIR,
      lastUpdated: stats.lastUpdated,
    });
  } catch (e) {
    console.error('[admin/stats]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// /admin/reset
// ============================================================
app.post('/admin/reset', function(req, res) {
  try {
    const token = req.headers['x-admin-token'] || req.query.token;
    if (token !== ADMIN_TOKEN) {
      return res.status(401).json({ error: '인증 실패' });
    }
    stats = defaultStats();
    persistStats();
    res.json({ ok: true, message: '통계 초기화 완료' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// /openai/chat — Vision 자동 감지
// ============================================================
app.post('/openai/chat', async function(req, res) {
  try {
    const body = req.body || {};
    const apiKey = body.apiKey;
    const system = body.system;
    const user = body.user;
    const image = body.image;
    const max_tokens = body.max_tokens;
    const temperature = body.temperature;
    const model = body.model;
    const response_format = body.response_format;
    
    if (!apiKey) return res.status(400).json({ error: 'apiKey 필요' });

    const isVision = !!image;
    const useModel = model || (isVision ? 'gpt-4o' : 'gpt-4o-mini');

    let userContent;
    if (isVision) {
      const imageUrl = image.indexOf('data:') === 0 ? image : ('data:image/jpeg;base64,' + image);
      userContent = [
        { type: 'text', text: user || '' },
        { type: 'image_url', image_url: { url: imageUrl } },
      ];
    } else {
      userContent = user || '';
    }

    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: userContent });

    const payload = { 
      model: useModel, 
      messages: messages, 
      max_tokens: max_tokens || 2000, 
      temperature: temperature !== undefined ? temperature : 0.9 
    };
    if (response_format) payload.response_format = response_format;

    const openaiRes = await fetch(OPENAI_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify(payload)
    });

    const data = await openaiRes.json();
    if (!openaiRes.ok) {
      const errMsg = (data && data.error && data.error.message) || 'OpenAI API error';
      console.error('[openai/chat]', errMsg);
      return res.status(openaiRes.status).json({ error: errMsg });
    }

    const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    return res.json({ 
      content: content, 
      text: content,
      model: useModel, 
      vision: isVision, 
      usage: data.usage 
    });
  } catch (err) {
    console.error('[openai/chat]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// /openai/scene — 배경 씬 생성
// ============================================================
app.post('/openai/scene', async function(req, res) {
  try {
    const body = req.body || {};
    const apiKey = body.apiKey;
    const object = body.object;
    const concept = body.concept;
    const category = body.category;
    const country = body.country;
    
    if (!apiKey) return res.status(400).json({ error: 'apiKey 필요' });
    if (!object) return res.status(400).json({ error: 'object 필요' });

    const system = 'You are a scene designer for AI short-form video prompts. Given an everyday object, output a natural setting.\n' +
      'Return STRICT JSON only:\n' +
      '{\n' +
      '  "loc": "<natural location phrase in English>",\n' +
      '  "props": "<2-3 supporting props in English, comma-separated>",\n' +
      '  "ambient": "<lighting and mood description in English>",\n' +
      '  "motion": "<subtle background motion description in English, one sentence>"\n' +
      '}';
    const userMsg = 'Object: ' + object + '\nCountry: ' + (country || 'kr') + '\nCategory: ' + (category || concept || 'general');

    const openaiRes = await fetch(OPENAI_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: system }, { role: 'user', content: userMsg }],
        max_tokens: 400, 
        temperature: 0.8,
        response_format: { type: 'json_object' }
      })
    });

    const data = await openaiRes.json();
    if (!openaiRes.ok) {
      const errMsg = (data && data.error && data.error.message) || 'OpenAI API error';
      return res.status(openaiRes.status).json({ error: errMsg });
    }
    const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '{}';
    let parsed = {};
    try { parsed = JSON.parse(content); } catch(_) {}
    return res.json(parsed);
  } catch (err) {
    console.error('[openai/scene]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// /openai/research — 정보 수집
// ============================================================
app.post('/openai/research', async function(req, res) {
  try {
    const body = req.body || {};
    const apiKey = body.apiKey;
    const object = body.object;
    const topic = body.topic;
    const country = body.country;
    const query = body.query;
    
    if (!apiKey) return res.status(400).json({ error: 'apiKey 필요' });

    const systemJSON = '너는 리서처다. 주어진 사물과 주제에 대해 실제로 유용한 정보를 JSON으로 반환.\n' +
      '반드시 STRICT JSON만:\n' +
      '{\n' +
      '  "reasons": ["<왜 안 좋은가 3-5개>"],\n' +
      '  "stats": ["<구체적 숫자/사실 2-4개>"],\n' +
      '  "common_mistakes": ["<사람들이 흔히 하는 실수 2-4개>"],\n' +
      '  "real_examples": ["<실제 사례 2-4개>"]\n' +
      '}';

    const userMsg = (object && topic)
      ? ('사물: ' + object + '\n주제: ' + topic + '\n국가: ' + (country || 'kr') + '\n\n위 사물이 "' + topic + '" 상황에 대해 잔소리할 때 쓸 수 있는 실용 정보. JSON만.')
      : (query || '일반 정보');

    const openaiRes = await fetch(OPENAI_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: systemJSON }, { role: 'user', content: userMsg }],
        max_tokens: 600, 
        temperature: 0.5,
        response_format: { type: 'json_object' }
      })
    });
    const data = await openaiRes.json();
    if (!openaiRes.ok) {
      const errMsg = (data && data.error && data.error.message) || 'OpenAI API error';
      return res.status(openaiRes.status).json({ error: errMsg });
    }
    
    const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '{}';
    let parsed = { reasons: [], stats: [], common_mistakes: [], real_examples: [] };
    try { 
      const p = JSON.parse(content);
      parsed.reasons = p.reasons || [];
      parsed.stats = p.stats || [];
      parsed.common_mistakes = p.common_mistakes || [];
      parsed.real_examples = p.real_examples || [];
    } catch(_) {}
    return res.json(parsed);
  } catch (err) {
    console.error('[openai/research]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Start
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('🚀 angry-prompt-server v3 listening on :' + PORT);
  console.log('   · storage: ' + DATA_DIR);
  console.log('   · admin token: ' + (ADMIN_TOKEN === 'zheila2026' ? '⚠️ DEFAULT (set ADMIN_TOKEN env)' : '✅ custom from env'));
  console.log('   · apps tracked: ' + Object.keys(stats.apps).length);
  console.log('   · endpoints: /, /openai/chat, /openai/scene, /openai/research, /track/visit, /track/generate, /admin/stats, /admin/reset');
});
