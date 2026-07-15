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
//   GET  /usage           -> current per-model usage from the shared proxy
//
// See worker/README.md for deployment instructions.

import { DurableObject } from 'cloudflare:workers';
import {
  DEFAULT_HUGGINGFACE_MODEL,
  buildUsageSnapshot,
  mergeUsageRecord,
  sanitizeUsageEvent,
  usageStorageKey,
} from './usage.js';

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const HUGGINGFACE_ENDPOINT = 'https://api-inference.huggingface.co/models';

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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

/** Strongly consistent shared counter, persisted by a SQLite Durable Object. */
export class UsageTracker extends DurableObject {
  async record(rawEvent) {
    const event = sanitizeUsageEvent(rawEvent);
    const key = usageStorageKey(event);
    return this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get(key);
      const next = mergeUsageRecord(current, event);
      await transaction.put(key, next);
      return next;
    });
  }

  async records() {
    const stored = await this.ctx.storage.list({ prefix: 'usage:' });
    return [...stored.values()];
  }
}

function usageTracker(env) {
  if (!env.USAGE_TRACKER) return null;
  const id = env.USAGE_TRACKER.idFromName('shared-recognition-api-usage');
  return env.USAGE_TRACKER.get(id);
}

async function recordUsage(env, event) {
  const tracker = usageTracker(env);
  if (!tracker) return;
  try {
    await tracker.record(event);
  } catch (error) {
    // Metering must never break the recognition response itself.
    console.warn('AI usage record failed:', error instanceof Error ? error.message : String(error));
  }
}

async function readUsage(env) {
  const tracker = usageTracker(env);
  if (!tracker) throw new Error('usage tracker is not configured');
  return buildUsageSnapshot(await tracker.records(), env);
}

function geminiUsageMetadata(responseBody) {
  try {
    const parsed = JSON.parse(responseBody);
    const usage = parsed?.usageMetadata || {};
    return {
      promptTokens: usage.promptTokenCount || 0,
      outputTokens: usage.candidatesTokenCount || 0,
      totalTokens: usage.totalTokenCount || 0,
    };
  } catch {
    return { promptTokens: 0, outputTokens: 0, totalTokens: 0 };
  }
}

function providerComputeSeconds(response, wallSeconds) {
  const raw = response.headers.get('x-compute-time');
  const value = raw == null ? Number.NaN : Number(raw);
  return {
    computeSeconds: Number.isFinite(value) && value >= 0 ? value : wallSeconds,
    computeSource: Number.isFinite(value) && value >= 0 ? 'provider' : 'wall',
  };
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

    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/usage') {
      try {
        return jsonResponse(await readUsage(env), 200, { ...headers, 'Cache-Control': 'no-store' });
      } catch (error) {
        return jsonResponse(
          { error: error instanceof Error ? error.message : String(error) },
          503,
          { ...headers, 'Cache-Control': 'no-store' },
        );
      }
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'not found' }, 404, headers);
    }

    if (url.pathname.startsWith('/gemini/')) {
      if (!env.GEMINI_API_KEY) {
        return jsonResponse({ error: 'GEMINI_API_KEY not configured on the proxy' }, 500, headers);
      }
      const model = decodeURIComponent(url.pathname.slice('/gemini/'.length));
      if (!model) return jsonResponse({ error: 'missing model' }, 400, headers);

      const upstream = `${GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
      const body = await request.text();
      const startedAt = Date.now();
      const res = await fetch(upstream, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const resBody = await res.text();
      const wallSeconds = Math.max(0, (Date.now() - startedAt) / 1000);
      await recordUsage(env, {
        provider: 'gemini',
        model,
        success: res.ok,
        wallSeconds,
        ...geminiUsageMetadata(resBody),
      });
      return new Response(resBody, { status: res.status, headers: { ...headers, 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/huggingface') {
      if (!env.HUGGINGFACE_API_KEY) {
        return jsonResponse({ error: 'HUGGINGFACE_API_KEY not configured on the proxy' }, 500, headers);
      }
      const model = env.HUGGINGFACE_MODEL || DEFAULT_HUGGINGFACE_MODEL;
      const upstream = `${HUGGINGFACE_ENDPOINT}/${model}`;
      const body = await request.text();
      const startedAt = Date.now();
      const res = await fetch(upstream, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.HUGGINGFACE_API_KEY}`,
        },
        body,
      });
      const resBody = await res.text();
      const wallSeconds = Math.max(0, (Date.now() - startedAt) / 1000);
      await recordUsage(env, {
        provider: 'huggingface',
        model,
        success: res.ok,
        wallSeconds,
        ...providerComputeSeconds(res, wallSeconds),
      });
      return new Response(resBody, { status: res.status, headers: { ...headers, 'Content-Type': 'application/json' } });
    }

    return jsonResponse({ error: 'not found' }, 404, headers);
  },
};
