// Shared recognition proxy for the lyrics app's score-recognition feature.
//
// Holds the site owner's Gemini / Hugging Face API keys as Worker secrets
// (never shipped to the browser) and forwards recognition requests to the
// real provider with the key attached. The client sends the exact same
// request body it would send directly to Gemini/Hugging Face — this Worker
// is a thin, transparent relay, not a reimplementation of the recognition
// logic.
//
// Routes:
//   POST /gemini/:model   -> https://generativelanguage.googleapis.com/v1beta/models/:model:generateContent
//   POST /huggingface     -> https://api-inference.huggingface.co/models/:HUGGINGFACE_MODEL
//
// See worker/README.md for deployment instructions.

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const HUGGINGFACE_ENDPOINT = 'https://api-inference.huggingface.co/models';
const DEFAULT_HUGGINGFACE_MODEL = 'Qwen/Qwen2-VL-7B-Instruct';

// Always allow the production GitHub Pages origin, even if ALLOWED_ORIGINS
// is unset or misconfigured on the Worker — the recognition proxy is useless
// to the deployed site otherwise.
const REQUIRED_ORIGINS = ['https://shrlak.github.io'];

function allowedOrigins(env) {
  return [
    ...REQUIRED_ORIGINS,
    ...String(env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  ];
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = allowedOrigins(env);
  const matched = allowed.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': matched,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

function jsonResponse(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    if (!headers['Access-Control-Allow-Origin']) {
      return jsonResponse({ error: 'origin not allowed' }, 403, headers);
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'not found' }, 404, headers);
    }

    const url = new URL(request.url);

    if (url.pathname.startsWith('/gemini/')) {
      if (!env.GEMINI_API_KEY) {
        return jsonResponse({ error: 'GEMINI_API_KEY not configured on the proxy' }, 500, headers);
      }
      const model = decodeURIComponent(url.pathname.slice('/gemini/'.length));
      if (!model) return jsonResponse({ error: 'missing model' }, 400, headers);

      const upstream = `${GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
      const body = await request.text();
      const res = await fetch(upstream, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const resBody = await res.text();
      return new Response(resBody, { status: res.status, headers: { ...headers, 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/huggingface') {
      if (!env.HUGGINGFACE_API_KEY) {
        return jsonResponse({ error: 'HUGGINGFACE_API_KEY not configured on the proxy' }, 500, headers);
      }
      const model = env.HUGGINGFACE_MODEL || DEFAULT_HUGGINGFACE_MODEL;
      const upstream = `${HUGGINGFACE_ENDPOINT}/${model}`;
      const body = await request.text();
      const res = await fetch(upstream, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.HUGGINGFACE_API_KEY}`,
        },
        body,
      });
      const resBody = await res.text();
      return new Response(resBody, { status: res.status, headers: { ...headers, 'Content-Type': 'application/json' } });
    }

    return jsonResponse({ error: 'not found' }, 404, headers);
  },
};
