// server.js - Railway OpenAI Proxy Server
// ═══════════════════════════════════════════════════════════════════
// 용도: 브라우저 → Railway → OpenAI (CORS 우회)
// 엔드포인트:
//   GET  /                → 헬스 체크
//   POST /openai/chat     → OpenAI Chat Completion 프록시 (대본/대사 생성)
//   POST /openai/scene    → 사물에 맞는 배경+ambient 동적 생성
// ═══════════════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');

const app = express();

// 모든 도메인 허용 (zhei-la.github.io 등)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));

// ═══ 헬스 체크 ═══
app.get('/', (req, res) => {
  res.json({ 
    status: 'OK', 
    service: 'OpenAI Proxy Server',
    endpoints: ['/openai/chat', '/openai/scene']
  });
});

// ═══ 1. OpenAI Chat Completion 프록시 ═══
app.post('/openai/chat', async (req, res) => {
  try {
    const { apiKey, system, user, max_tokens, temperature } = req.body;

    if (!apiKey || !apiKey.startsWith('sk-')) {
      return res.status(400).json({ error: 'Invalid API key (must start with sk-)' });
    }
    if (!system || !user) {
      return res.status(400).json({ error: 'Missing system or user message' });
    }

    const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: max_tokens || 2000,
        temperature: temperature || 0.95,
        presence_penalty: 0.3,
        frequency_penalty: 0.3,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      })
    });

    const data = await openaiResponse.json();

    if (!openaiResponse.ok) {
      console.error('OpenAI error:', data);
      return res.status(openaiResponse.status).json({
        error: (data && data.error && data.error.message) || 'OpenAI API error'
      });
    }

    const text = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    res.json({ text: text });

  } catch (err) {
    console.error('[/openai/chat] Proxy error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══ 2. 사물 맞춤 배경+ambient 동적 생성 ═══
app.post('/openai/scene', async (req, res) => {
  try {
    const { apiKey, object, country, category } = req.body;

    if (!apiKey || !apiKey.startsWith('sk-')) {
      return res.status(400).json({ error: 'Invalid API key' });
    }
    if (!object) {
      return res.status(400).json({ error: 'Missing object' });
    }

    const isJP = country === 'jp';
    const systemPrompt = isJP
      ? 'You are a cinematic scene designer. Given a personified object, describe its NATIVE HABITAT (where it naturally lives in a real Japanese 1K urban apartment) with realistic, lived-in detail. Output must be natural English suitable for AI image/video prompts. Output JSON ONLY, no explanation.\n\nJSON format:\n{\n  "loc": "short scene location phrase (English, where this object naturally sits in a Japanese apartment)",\n  "props": "3-5 specific contextual items visible around the object in its native habitat, one flowing sentence in English",\n  "ambient": "1-2 subtle ambient motion points (gentle environmental movement that makes the scene feel alive, not cluttered). Examples: steam rising from tea kettle, curtain barely swaying, dust particles in light beams. One sentence in English."\n}'
      : 'You are a cinematic scene designer. Given a personified object, describe its NATIVE HABITAT (where it naturally lives in a real Korean one-room apartment or office) with realistic, lived-in detail. Output must be natural English suitable for AI image/video prompts. Output JSON ONLY, no explanation.\n\nJSON format:\n{\n  "loc": "short scene location phrase (English, where this object naturally sits in a Korean apartment/office)",\n  "props": "3-5 specific contextual items visible around the object in its native habitat, one flowing sentence in English",\n  "ambient": "1-2 subtle ambient motion points (gentle environmental movement that makes the scene feel alive, not cluttered). Examples: steam rising from the rice cooker vent, curtain barely swaying, dust particles in light beams. One sentence in English."\n}';

    const userPrompt = 'Object: ' + object + (category ? '\nCategory: ' + category : '') + '\n\nGenerate the native habitat scene JSON.';

    const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 500,
        temperature: 0.8,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      })
    });

    const data = await openaiResponse.json();

    if (!openaiResponse.ok) {
      return res.status(openaiResponse.status).json({
        error: (data && data.error && data.error.message) || 'OpenAI API error'
      });
    }

    const text = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '{}';
    let scene;
    try {
      scene = JSON.parse(text);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to parse scene JSON', raw: text });
    }

    res.json({
      loc: scene.loc || (isJP ? 'in a Japanese 1K urban apartment' : 'in a Korean one-room apartment'),
      props: scene.props || 'contextually relevant items placed naturally around the subject',
      ambient: scene.ambient || 'subtle ambient life — dust in light, fabric edges faintly moving'
    });

  } catch (err) {
    console.error('[/openai/scene] error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log('✅ OpenAI Proxy Server running on port ' + PORT);
  console.log('   Endpoints: GET /, POST /openai/chat, POST /openai/scene');
});

