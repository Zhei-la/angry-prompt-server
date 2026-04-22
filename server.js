// ============================================================
// server.js — 오늘의 참견 / 인스타툰 공용 Railway 프록시
// Update: Vision 지원 추가 (image 필드 base64로 받으면 gpt-4o vision 호출)
// by 제일라 · GitHub: Zhei-la/youtub-prompt
// ============================================================

const express = require('express');
const cors = require('cors');

const app = express();

// Railway CPU memory 고려해서 10MB까지 허용 (base64 이미지 용)
app.use(express.json({ limit: '10mb' }));
app.use(cors());

const OPENAI_API = 'https://api.openai.com/v1/chat/completions';

// ============================================================
// Health check
// ============================================================
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'angry-prompt-server',
    endpoints: ['/openai/chat', '/openai/scene', '/openai/research'],
    features: { vision: true }
  });
});

// ============================================================
// /openai/chat — 공용 chat 엔드포인트
// body:
//   { apiKey, system, user, image?, vision?, model?, max_tokens?, temperature? }
// image 필드가 있으면 vision 모드로 동작 (gpt-4o)
// ============================================================
app.post('/openai/chat', async (req, res) => {
  try {
    const {
      apiKey,
      system,
      user,
      image,
      vision,
      model,
      max_tokens = 900,
      temperature = 0.8,
      response_format
    } = req.body || {};

    if (!apiKey) return res.status(400).json({ error: 'apiKey 필요' });
    if (!system && !user) return res.status(400).json({ error: 'system 또는 user 필요' });

    // ---------- Vision 모드 ----------
    const isVision = !!(image || vision);
    const useModel = model || (isVision ? 'gpt-4o' : 'gpt-4o-mini');

    let userContent;
    if (isVision && image) {
      // base64 이미지 (data: prefix 허용, 없으면 image/jpeg 가정)
      const dataUrl = image.startsWith('data:')
        ? image
        : `data:image/jpeg;base64,${image}`;
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

    const payload = {
      model: useModel,
      messages,
      max_tokens,
      temperature
    };
    if (response_format) payload.response_format = response_format;

    const openaiRes = await fetch(OPENAI_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    const data = await openaiRes.json();
    if (!openaiRes.ok) {
      console.error('[openai/chat] OpenAI error:', data);
      return res.status(openaiRes.status).json({
        error: data.error?.message || 'OpenAI API error',
        raw: data
      });
    }

    const content = data.choices?.[0]?.message?.content || '';
    // 클라이언트 편의 위해 { content } 통일 반환 + raw도 포함
    return res.json({
      content,
      model: useModel,
      vision: isVision,
      usage: data.usage
    });

  } catch (err) {
    console.error('[openai/chat] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// /openai/scene — 사물 배경 자동 생성 (기존 유지)
// loc, props, ambient, motion 반환
// ============================================================
app.post('/openai/scene', async (req, res) => {
  try {
    const { apiKey, object, concept } = req.body || {};
    if (!apiKey) return res.status(400).json({ error: 'apiKey 필요' });
    if (!object) return res.status(400).json({ error: 'object 필요' });

    const system = `You are a scene designer for AI short-form video prompts. Given an everyday object and a concept, output a natural setting for this object.
Return STRICT JSON only:
{
  "loc": "<natural location in English, e.g. 'on a kitchen counter'>",
  "props": "<1-3 supporting props in English, comma-separated>",
  "ambient": "<lighting/mood description in English>",
  "motion": "<subtle background motion description in English>"
}`;
    const user = `Object: ${object}\nConcept: ${concept || 'general'}`;

    const openaiRes = await fetch(OPENAI_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        max_tokens: 300,
        temperature: 0.8,
        response_format: { type: 'json_object' }
      })
    });

    const data = await openaiRes.json();
    if (!openaiRes.ok) {
      return res.status(openaiRes.status).json({ error: data.error?.message || 'OpenAI API error' });
    }
    const content = data.choices?.[0]?.message?.content || '{}';
    let parsed = {};
    try { parsed = JSON.parse(content); } catch(_) {}
    return res.json(parsed);

  } catch (err) {
    console.error('[openai/scene] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// /openai/research — 웹 검색 (간단 스텁, 기존 유지)
// 실제 구현은 별도 검색 API 연동 필요
// ============================================================
app.post('/openai/research', async (req, res) => {
  try {
    const { apiKey, query } = req.body || {};
    if (!apiKey) return res.status(400).json({ error: 'apiKey 필요' });

    const system = '너는 리서처다. 주제에 대한 사실 기반 정보를 3~5 문장으로 요약해서 한국어로 출력.';
    const openaiRes = await fetch(OPENAI_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: query || '' }
        ],
        max_tokens: 400,
        temperature: 0.5
      })
    });
    const data = await openaiRes.json();
    if (!openaiRes.ok) {
      return res.status(openaiRes.status).json({ error: data.error?.message || 'OpenAI API error' });
    }
    return res.json({ content: data.choices?.[0]?.message?.content || '' });

  } catch (err) {
    console.error('[openai/research] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Start
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 angry-prompt-server listening on :${PORT}`);
  console.log(`   · vision enabled (gpt-4o)`);
});
