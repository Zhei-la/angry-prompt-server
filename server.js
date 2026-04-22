// server.js - Railway OpenAI Proxy Server (with Web Research)
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => {
  res.json({
    status: 'OK',
    service: 'OpenAI Proxy Server',
    endpoints: ['/openai/chat', '/openai/scene', '/openai/research']
  });
});

// ═══ 1. Chat Completion 프록시 ═══
app.post('/openai/chat', async (req, res) => {
  try {
    const { apiKey, system, user, max_tokens, temperature } = req.body;
    if (!apiKey || !apiKey.startsWith('sk-')) {
      return res.status(400).json({ error: 'Invalid API key' });
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
      return res.status(openaiResponse.status).json({
        error: (data && data.error && data.error.message) || 'OpenAI API error'
      });
    }
    const text = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    res.json({ text: text });
  } catch (err) {
    console.error('[/openai/chat] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══ 2. Scene 생성 ═══
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
      ? 'You are a cinematic scene designer. Given a personified object, describe (1) its NATIVE HABITAT in a real Japanese 1K apartment AND (2) what visually-interesting motion happens around or from this specific object (its functional working motion if it is a device, OR satisfying surrounding life if it is a plant/food/animal/decor — e.g. flowers attract butterflies and bees, coffee gives off steam, vacuum sucks dust, washing machine drum spins with tumbling laundry, alarm clock numbers tick, fish swim with bubbles). Output JSON ONLY. Format: {"loc":"scene location phrase","props":"3-5 contextual items in one sentence","ambient":"1-2 subtle ambient motion points","motion":"specific functional/surrounding visual motion of THIS object that makes the scene feel alive and visually satisfying — be concrete and specific to this object"}'
      : 'You are a cinematic scene designer. Given a personified object, describe (1) its NATIVE HABITAT in a real Korean one-room apartment or office AND (2) what visually-interesting motion happens around or from this specific object (its functional working motion if it is a device, OR satisfying surrounding life if it is a plant/food/animal/decor — e.g. flowers attract butterflies and bees, coffee gives off steam, vacuum sucks dust, washing machine drum spins with tumbling laundry, alarm clock numbers tick, fish swim with bubbles). Output JSON ONLY. Format: {"loc":"scene location phrase","props":"3-5 contextual items in one sentence","ambient":"1-2 subtle ambient motion points","motion":"specific functional/surrounding visual motion of THIS object that makes the scene feel alive and visually satisfying — be concrete and specific to this object"}';

    const userPrompt = 'Object: ' + object + (category ? '\nCategory: ' + category : '') + '\n\nGenerate scene JSON with all four fields including motion.';

    const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 700,
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
      return res.status(500).json({ error: 'Parse failed', raw: text });
    }

    res.json({
      loc: scene.loc || (isJP ? 'in a Japanese 1K apartment' : 'in a Korean one-room apartment'),
      props: scene.props || 'contextually relevant items placed around the subject',
      ambient: scene.ambient || 'subtle ambient life - dust in light, fabric edges faintly moving',
      motion: scene.motion || ''
    });
  } catch (err) {
    console.error('[/openai/scene] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══ 3. Research - 웹 검색 기반 정보 수집 ═══
app.post('/openai/research', async (req, res) => {
  try {
    const { apiKey, object, topic, country } = req.body;
    if (!apiKey || !apiKey.startsWith('sk-')) {
      return res.status(400).json({ error: 'Invalid API key' });
    }
    if (!object || !topic) {
      return res.status(400).json({ error: 'Missing object or topic' });
    }

    const isKR = country !== 'jp';
    const lang = isKR ? 'Korean' : 'Japanese';
    const countryDesc = isKR ? '한국' : '일본';

    const systemPrompt = 'You are a research assistant. Search the web for factual information and return specific, useful details in ' + lang + '.\n\n' +
      'Focus on:\n' +
      '1. WHY the behavior/habit is bad (health, environment, social, financial reasons)\n' +
      '2. SPECIFIC consequences with numbers/stats if available\n' +
      '3. HOW people actually do it wrong (common mistakes)\n' +
      '4. CONCRETE examples from real life\n\n' +
      'Return JSON only:\n' +
      '{\n' +
      '  "reasons": ["specific reason 1 with detail", "specific reason 2"],\n' +
      '  "stats": ["numerical fact 1", "numerical fact 2"],\n' +
      '  "common_mistakes": ["common mistake 1", "common mistake 2"],\n' +
      '  "real_examples": ["real scenario 1", "real scenario 2"]\n' +
      '}\n\n' +
      'All content in ' + lang + '. Be specific. Avoid vague statements.';

    const userPrompt = 'Object: ' + object + '\n' +
      'Topic/problematic behavior: ' + topic + '\n' +
      'Country: ' + countryDesc + '\n\n' +
      'Search and compile detailed information about why "' + topic + '" with "' + object + '" is a bad habit. Include specific reasons, statistics, common mistakes, and real-life examples.\n\n' +
      'Return JSON only.';

    const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model: 'gpt-4o-search-preview',
        web_search_options: {},
        max_tokens: 1500,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      })
    });

    const data = await openaiResponse.json();
    if (!openaiResponse.ok) {
      console.error('research error:', data);
      return res.status(openaiResponse.status).json({
        error: (data && data.error && data.error.message) || 'Web search API error'
      });
    }

    const text = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '{}';

    let research;
    try {
      const m = text.match(/\{[\s\S]*\}/);
      const cleaned = m ? m[0] : text;
      research = JSON.parse(cleaned);
    } catch (e) {
      return res.json({
        reasons: [text.substring(0, 500)],
        stats: [],
        common_mistakes: [],
        real_examples: [],
        raw: true
      });
    }

    res.json({
      reasons: Array.isArray(research.reasons) ? research.reasons : [],
      stats: Array.isArray(research.stats) ? research.stats : [],
      common_mistakes: Array.isArray(research.common_mistakes) ? research.common_mistakes : [],
      real_examples: Array.isArray(research.real_examples) ? research.real_examples : []
    });
  } catch (err) {
    console.error('[/openai/research] error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log('OpenAI Proxy Server running on port ' + PORT);
  console.log('Endpoints: /, /openai/chat, /openai/scene, /openai/research');
});
