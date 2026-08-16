// Shared recognition proxy for the lyrics app's score-recognition feature.
//
// Holds the site owner's Gemini / OpenRouter API keys as Worker
// secrets (never shipped to the browser) and forwards recognition requests
// to the real provider with the key attached. The client sends the exact
// same request body it would send directly to the provider — this Worker is
// a thin, transparent relay, not a reimplementation of the recognition
// logic.
//
// Routes:
//   POST /gemini/:model   -> https://generativelanguage.googleapis.com/v1beta/models/:model:generateContent
//   POST /openrouter      -> OpenRouter free vision models (legacy alias: /nvidia)
//   GET  /lyrics          -> published lyrics for a recognized 찬양 제목
//   GET  /usage           -> current per-model usage from the shared proxy
//   GET  /settings        -> shared recognition settings (model pool, excluded titles)
//   POST /settings        -> update shared settings (관리자 비밀번호 required)
//   GET/PUT/DELETE /libraries/lyrics -> shared lyrics library
//   GET/POST/DELETE /libraries/ppt   -> shared PPT library and chunk transfer
//   GET/POST /libraries/ppt/purge    -> weekly purge status / run it now
//
// A cron trigger (see wrangler.toml) wipes the shared PPT library every
// Sunday at 5 PM local time; src/purge.js owns that schedule.
//
// See worker/README.md for deployment instructions.

import { DurableObject } from 'cloudflare:workers';
import {
  buildUsageSnapshot,
  mergeUsageRecord,
  sanitizeUsageEvent,
  usageStorageKey,
} from './usage.js';
import { adminPassword, resolveOpenRouterRoute, sanitizeSharedSettings, usageCatalogModels } from './config.js';
import {
  MAX_PPT_LIBRARY_DECKS,
  PPT_CHUNK_BYTES,
  PPT_FILE_KINDS,
  matchDeckChunkRoute,
  matchUploadChunkRoute,
  isGroundTruth,
  entryVerification,
  normalizeLibraryTitle,
  samePptFiles,
  sanitizeLyricsEntries,
  sanitizeLyricsEntry,
  sanitizePptDeckMetadata,
  sanitizePptUpload,
  validLibraryId,
} from './library.js';
import { purgeDecision, purgeSchedule, staleTombstoneKeys, zonedParts } from './purge.js';
import { fetchWebLyrics } from './lyrics.js';

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

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
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    Vary: 'Origin',
  };
}

function jsonResponse(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

/**
 * Strongly consistent shared state, persisted by a SQLite Durable Object:
 * usage counters plus the shared recognition settings (model pool and
 * excluded titles) every device reads.
 */
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

  async getSharedSettings() {
    return (await this.ctx.storage.get('shared-settings')) ?? null;
  }

  async setSharedSettings(value) {
    await this.ctx.storage.put('shared-settings', value);
    return value;
  }

  async lyricsLibrary() {
    const stored = await this.ctx.storage.list({ prefix: 'library:lyrics:entry:' });
    const tombstones = await this.ctx.storage.list({ prefix: 'library:lyrics:deleted:' });
    return {
      entries: [...stored.values()].map((value) => value.entry).filter(Boolean),
      deletedTitles: [...tombstones.values()].map((value) => value.normalizedTitle).filter(Boolean),
    };
  }

  async mergeLyricsLibrary(rawEntries) {
    const entries = sanitizeLyricsEntries(rawEntries);
    for (const entry of entries) {
      const normalized = normalizeLibraryTitle(entry.title);
      const entryKey = `library:lyrics:entry:${normalized}`;
      const deletedKey = `library:lyrics:deleted:${normalized}`;
      const [existing, deleted] = await Promise.all([
        this.ctx.storage.get(entryKey),
        this.ctx.storage.get(deletedKey),
      ]);
      // The merge route is only for one-time migration of browser data. A
      // cloud copy wins, and a deletion tombstone must never be resurrected
      // by another device's stale IndexedDB/localStorage cache.
      if (!existing && !deleted) {
        await this.ctx.storage.put(entryKey, { entry, updatedAt: new Date().toISOString() });
      }
    }
    return this.lyricsLibrary();
  }

  /**
   * Store a lyrics entry, refusing to let a draft replace ground truth.
   *
   * Recognition runs on every conti, so the same song is offered again and
   * again as a fresh draft. Without this guard a weak reading would overwrite
   * the wording a user already confirmed. An explicit verified/edited save
   * still replaces whatever is stored.
   */
  async upsertLyricsEntry(rawEntry) {
    const entry = sanitizeLyricsEntry(rawEntry);
    if (!entry) throw new Error('invalid lyrics entry');
    const normalized = normalizeLibraryTitle(entry.title);
    const entryKey = `library:lyrics:entry:${normalized}`;
    const existing = await this.ctx.storage.get(entryKey);
    if (existing?.entry && entryVerification(entry) === 'draft' && isGroundTruth(existing.entry)) {
      return existing.entry;
    }
    await this.ctx.storage.put(entryKey, {
      entry,
      updatedAt: new Date().toISOString(),
    });
    await this.ctx.storage.delete(`library:lyrics:deleted:${normalized}`);
    return entry;
  }

  async deleteLyricsEntry(title) {
    const normalized = normalizeLibraryTitle(title);
    if (!normalized) throw new Error('invalid lyrics title');
    await this.ctx.storage.delete(`library:lyrics:entry:${normalized}`);
    await this.ctx.storage.put(`library:lyrics:deleted:${normalized}`, {
      normalizedTitle: normalized,
      deletedAt: new Date().toISOString(),
    });
  }

  async cleanupPptUpload(uploadId, files) {
    const keys = [];
    for (const kind of PPT_FILE_KINDS) {
      const descriptor = files?.[kind];
      if (!descriptor) continue;
      for (let index = 0; index < descriptor.chunkCount; index += 1) {
        keys.push(`library:ppt:chunk:${uploadId}:${kind}:${index}`);
      }
    }
    for (let index = 0; index < keys.length; index += 128) {
      await this.ctx.storage.delete(keys.slice(index, index + 128));
    }
  }

  async cleanupStalePptUploads() {
    const manifests = await this.ctx.storage.list({ prefix: 'library:ppt:upload:' });
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [key, manifest] of manifests) {
      if (new Date(manifest.createdAt).getTime() >= cutoff) continue;
      await this.cleanupPptUpload(manifest.uploadId, manifest.files);
      await this.ctx.storage.delete(key);
    }
  }

  async startPptUpload(rawUpload) {
    const upload = sanitizePptUpload(rawUpload);
    if (!upload) throw new Error('invalid PPT upload');
    await this.cleanupStalePptUploads();
    const key = `library:ppt:upload:${upload.uploadId}`;
    if (await this.ctx.storage.get(key)) throw new Error('upload already exists');
    const manifest = { ...upload, createdAt: new Date().toISOString() };
    await this.ctx.storage.put(key, manifest);
    return manifest;
  }

  async putPptChunk(uploadId, kind, index, data) {
    if (!validLibraryId(uploadId) || !PPT_FILE_KINDS.includes(kind)) throw new Error('invalid chunk target');
    const manifest = await this.ctx.storage.get(`library:ppt:upload:${uploadId}`);
    const descriptor = manifest?.files?.[kind];
    if (!descriptor || !Number.isSafeInteger(index) || index < 0 || index >= descriptor.chunkCount) {
      throw new Error('invalid chunk index');
    }
    if (!(data instanceof ArrayBuffer) || data.byteLength === 0 || data.byteLength > PPT_CHUNK_BYTES) {
      throw new Error('invalid chunk body');
    }
    const expectedBytes =
      index === descriptor.chunkCount - 1
        ? descriptor.size - PPT_CHUNK_BYTES * (descriptor.chunkCount - 1)
        : PPT_CHUNK_BYTES;
    if (data.byteLength !== expectedBytes) throw new Error('chunk size does not match manifest');
    await this.ctx.storage.put(`library:ppt:chunk:${uploadId}:${kind}:${index}`, data);
  }

  async commitPptDeck(rawDeck) {
    const deck = sanitizePptDeckMetadata(rawDeck);
    if (!deck) throw new Error('invalid PPT metadata');
    const uploadKey = `library:ppt:upload:${deck.uploadId}`;
    const manifest = await this.ctx.storage.get(uploadKey);
    if (!manifest || manifest.deckId !== deck.id || !samePptFiles(manifest.files, deck.files)) {
      throw new Error('PPT upload manifest does not match');
    }

    for (const kind of PPT_FILE_KINDS) {
      const descriptor = deck.files[kind];
      if (!descriptor) continue;
      for (let index = 0; index < descriptor.chunkCount; index += 1) {
        const chunk = await this.ctx.storage.get(`library:ppt:chunk:${deck.uploadId}:${kind}:${index}`);
        if (!(chunk instanceof ArrayBuffer)) throw new Error(`missing ${kind} chunk ${index}`);
      }
    }

    const metaKey = `library:ppt:meta:${deck.id}`;
    const previous = await this.ctx.storage.get(metaKey);
    if (!previous) {
      const all = await this.ctx.storage.list({ prefix: 'library:ppt:meta:' });
      if (all.size >= MAX_PPT_LIBRARY_DECKS) throw new Error('PPT library is full');
    }
    await this.ctx.storage.put(metaKey, deck);
    await this.ctx.storage.delete(uploadKey);
    await this.ctx.storage.delete(`library:ppt:deleted:${deck.id}`);
    if (previous && previous.uploadId !== deck.uploadId) {
      await this.cleanupPptUpload(previous.uploadId, previous.files);
    }
    return deck;
  }

  async pptLibrary() {
    const [stored, tombstones] = await Promise.all([
      this.ctx.storage.list({ prefix: 'library:ppt:meta:' }),
      this.ctx.storage.list({ prefix: 'library:ppt:deleted:' }),
    ]);
    return {
      decks: [...stored.values()].sort((a, b) => b.savedAt.localeCompare(a.savedAt)),
      deletedIds: [...tombstones.values()].map((value) => value.id).filter(Boolean),
    };
  }

  async getPptDeck(id) {
    if (!validLibraryId(id, 100)) return null;
    return (await this.ctx.storage.get(`library:ppt:meta:${id}`)) ?? null;
  }

  async getPptChunk(id, kind, index) {
    const deck = await this.getPptDeck(id);
    const descriptor = deck?.files?.[kind];
    if (!descriptor || !Number.isSafeInteger(index) || index < 0 || index >= descriptor.chunkCount) return null;
    return (await this.ctx.storage.get(`library:ppt:chunk:${deck.uploadId}:${kind}:${index}`)) ?? null;
  }

  /** Drop tombstones no offline device could still need (see purge.js). */
  async prunePptTombstones(now) {
    const tombstones = await this.ctx.storage.list({ prefix: 'library:ppt:deleted:' });
    const stale = staleTombstoneKeys(tombstones, now);
    for (let index = 0; index < stale.length; index += 128) {
      await this.ctx.storage.delete(stale.slice(index, index + 128));
    }
    return stale.length;
  }

  async lastPptPurge() {
    return (await this.ctx.storage.get('library:ppt:purge')) ?? null;
  }

  /**
   * The weekly wipe: every saved deck, every file on it (PPTX, 콘티 PDF, 설교
   * PPT and the inputs snapshot) and any half-finished upload. Each deck
   * leaves a tombstone behind so a device holding a cached copy deletes it on
   * the next sync instead of uploading it straight back. The 곡 라이브러리 is
   * a song database rather than a week's material, so it is never touched.
   */
  async purgePptLibrary({ purgeKey = null, at = new Date().toISOString(), trigger = 'scheduled' } = {}) {
    const now = new Date(at);
    const timestamp = Number.isFinite(now.getTime()) ? now : new Date();
    const decks = await this.ctx.storage.list({ prefix: 'library:ppt:meta:' });
    let files = 0;
    let bytes = 0;
    for (const [key, deck] of decks) {
      await this.cleanupPptUpload(deck.uploadId, deck.files);
      await this.ctx.storage.delete(key);
      await this.ctx.storage.put(`library:ppt:deleted:${deck.id}`, {
        id: deck.id,
        deletedAt: timestamp.toISOString(),
        reason: 'weekly-purge',
      });
      for (const kind of PPT_FILE_KINDS) {
        const descriptor = deck.files?.[kind];
        if (!descriptor) continue;
        files += 1;
        bytes += descriptor.size;
      }
    }

    const uploads = await this.ctx.storage.list({ prefix: 'library:ppt:upload:' });
    for (const [key, manifest] of uploads) {
      await this.cleanupPptUpload(manifest.uploadId, manifest.files);
      await this.ctx.storage.delete(key);
    }

    const record = {
      // Null for a manual run: forcing a purge on Sunday morning must not
      // cancel that evening's scheduled one.
      purgeKey,
      trigger,
      at: timestamp.toISOString(),
      decks: decks.size,
      files,
      bytes,
      uploads: uploads.size,
      prunedTombstones: await this.prunePptTombstones(timestamp),
    };
    await this.ctx.storage.put('library:ppt:purge', record);
    return record;
  }

  async deletePptDeck(id) {
    if (!validLibraryId(id, 100)) throw new Error('invalid PPT library ID');
    const deck = await this.getPptDeck(id);
    if (deck) {
      await this.ctx.storage.delete(`library:ppt:meta:${id}`);
      await this.cleanupPptUpload(deck.uploadId, deck.files);
    }
    await this.ctx.storage.put(`library:ppt:deleted:${id}`, { id, deletedAt: new Date().toISOString() });
  }
}

function usageTracker(env) {
  if (!env.USAGE_TRACKER) return null;
  const id = env.USAGE_TRACKER.idFromName('shared-recognition-api-usage');
  return env.USAGE_TRACKER.get(id);
}

function isAdminRequest(request, env) {
  const authorization = request.headers.get('Authorization') || '';
  return authorization === `Bearer ${adminPassword(env)}`;
}

function libraryError(error, headers, status = 400) {
  return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, status, {
    ...headers,
    'Cache-Control': 'no-store',
  });
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
  return buildUsageSnapshot(await tracker.records(), env, new Date(), usageCatalogModels());
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

/** Token usage from an OpenAI-compatible chat-completions response body. */
function openAiUsageMetadata(responseBody) {
  try {
    const parsed = JSON.parse(responseBody);
    const usage = parsed?.usage || {};
    return {
      promptTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0,
      totalTokens: usage.total_tokens || 0,
    };
  } catch {
    return { promptTokens: 0, outputTokens: 0, totalTokens: 0 };
  }
}

/**
 * Cron entry point for the weekly wipe. wrangler.toml fires this at both UTC
 * hours that can be 5 PM local, and purgeDecision() lets exactly one of them
 * through per week.
 */
async function runScheduledPurge(env, now) {
  const tracker = usageTracker(env);
  if (!tracker) {
    console.warn('weekly PPT purge skipped: shared library storage is not configured');
    return null;
  }
  const last = await tracker.lastPptPurge();
  const decision = purgeDecision(now, last?.purgeKey ?? null, env);
  if (!decision.purge) {
    console.log(`weekly PPT purge skipped at ${decision.localTime}: ${decision.reason}`);
    return null;
  }
  const result = await tracker.purgePptLibrary({
    purgeKey: decision.purgeKey,
    at: now.toISOString(),
    trigger: 'scheduled',
  });
  console.log(
    `weekly PPT purge at ${decision.localTime}: removed ${result.decks} deck(s), ` +
      `${result.files} file(s), ${result.bytes} byte(s), ${result.uploads} pending upload(s)`,
  );
  return result;
}

export default {
  async scheduled(controller, env, ctx) {
    const now = new Date(controller?.scheduledTime ?? Date.now());
    ctx.waitUntil(
      runScheduledPurge(env, Number.isFinite(now.getTime()) ? now : new Date()).catch((error) => {
        // A failed purge must not retry-loop the cron; the next firing (an
        // hour later, or next Sunday) tries again on its own.
        console.error('weekly PPT purge failed:', error instanceof Error ? error.message : String(error));
      }),
    );
  },

  async fetch(request, env) {
    const headers = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    if (!headers['Access-Control-Allow-Origin']) {
      return jsonResponse({ error: 'origin not allowed' }, 403, headers);
    }

    const url = new URL(request.url);

    // Cross-device libraries share the same strongly consistent Durable
    // Object already used by recognition settings. Reads are available to the
    // app; writes use the same administrator password as 관리자 설정.
    if (url.pathname === '/libraries/lyrics') {
      const tracker = usageTracker(env);
      if (!tracker) return libraryError('shared library storage is not configured', headers, 503);
      try {
        if (request.method === 'GET') {
          return jsonResponse(await tracker.lyricsLibrary(), 200, { ...headers, 'Cache-Control': 'no-store' });
        }
        if (!isAdminRequest(request, env)) return libraryError('관리자 비밀번호가 올바르지 않습니다.', headers, 403);
        const body = JSON.parse(await request.text());
        if (request.method === 'POST') {
          return jsonResponse(await tracker.mergeLyricsLibrary(body.entries), 200, {
            ...headers,
            'Cache-Control': 'no-store',
          });
        }
        if (request.method === 'PUT') {
          return jsonResponse({ entry: await tracker.upsertLyricsEntry(body.entry) }, 200, {
            ...headers,
            'Cache-Control': 'no-store',
          });
        }
        if (request.method === 'DELETE') {
          await tracker.deleteLyricsEntry(body.title);
          return jsonResponse({ ok: true }, 200, { ...headers, 'Cache-Control': 'no-store' });
        }
      } catch (error) {
        return libraryError(error, headers);
      }
      return libraryError('not found', headers, 404);
    }

    if (url.pathname === '/libraries/ppt') {
      const tracker = usageTracker(env);
      if (!tracker) return libraryError('shared library storage is not configured', headers, 503);
      if (request.method !== 'GET') return libraryError('not found', headers, 404);
      try {
        return jsonResponse(await tracker.pptLibrary(), 200, { ...headers, 'Cache-Control': 'no-store' });
      } catch (error) {
        return libraryError(error, headers, 500);
      }
    }

    const uploadStart = url.pathname.match(/^\/libraries\/ppt\/uploads\/([A-Za-z0-9_-]+)$/);
    if (uploadStart && request.method === 'POST') {
      if (!isAdminRequest(request, env)) return libraryError('관리자 비밀번호가 올바르지 않습니다.', headers, 403);
      const tracker = usageTracker(env);
      if (!tracker) return libraryError('shared library storage is not configured', headers, 503);
      try {
        const body = JSON.parse(await request.text());
        if (body.uploadId !== uploadStart[1]) return libraryError('upload ID does not match', headers);
        return jsonResponse(await tracker.startPptUpload(body), 201, { ...headers, 'Cache-Control': 'no-store' });
      } catch (error) {
        return libraryError(error, headers);
      }
    }

    const chunkUpload = matchUploadChunkRoute(url.pathname);
    if (chunkUpload && request.method === 'PUT') {
      if (!isAdminRequest(request, env)) return libraryError('관리자 비밀번호가 올바르지 않습니다.', headers, 403);
      const tracker = usageTracker(env);
      if (!tracker) return libraryError('shared library storage is not configured', headers, 503);
      try {
        await tracker.putPptChunk(chunkUpload.uploadId, chunkUpload.kind, chunkUpload.index, await request.arrayBuffer());
        return jsonResponse({ ok: true }, 200, { ...headers, 'Cache-Control': 'no-store' });
      } catch (error) {
        return libraryError(error, headers);
      }
    }

    const pptChunk = matchDeckChunkRoute(url.pathname);
    if (pptChunk && request.method === 'GET') {
      const tracker = usageTracker(env);
      if (!tracker) return libraryError('shared library storage is not configured', headers, 503);
      const chunk = await tracker.getPptChunk(pptChunk.deckId, pptChunk.kind, pptChunk.index);
      if (!(chunk instanceof ArrayBuffer)) return libraryError('file chunk not found', headers, 404);
      return new Response(chunk, {
        status: 200,
        headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, max-age=300' },
      });
    }

    // Ahead of the /libraries/ppt/:id deck route below, which would otherwise
    // read "purge" as a deck ID.
    if (url.pathname === '/libraries/ppt/purge') {
      const tracker = usageTracker(env);
      if (!tracker) return libraryError('shared library storage is not configured', headers, 503);
      const schedule = purgeSchedule(env);
      try {
        if (request.method === 'GET') {
          return jsonResponse({ schedule, last: await tracker.lastPptPurge() }, 200, {
            ...headers,
            'Cache-Control': 'no-store',
          });
        }
        if (request.method === 'POST') {
          if (!isAdminRequest(request, env)) return libraryError('관리자 비밀번호가 올바르지 않습니다.', headers, 403);
          const now = new Date();
          const purge = await tracker.purgePptLibrary({ at: now.toISOString(), trigger: 'manual' });
          return jsonResponse({ schedule, localTime: zonedParts(now, schedule.timeZone), purge }, 200, {
            ...headers,
            'Cache-Control': 'no-store',
          });
        }
      } catch (error) {
        return libraryError(error, headers, 500);
      }
      return libraryError('not found', headers, 404);
    }

    const pptDeck = url.pathname.match(/^\/libraries\/ppt\/([A-Za-z0-9_-]+)$/);
    if (pptDeck) {
      const tracker = usageTracker(env);
      if (!tracker) return libraryError('shared library storage is not configured', headers, 503);
      try {
        if (request.method === 'GET') {
          const deck = await tracker.getPptDeck(pptDeck[1]);
          return deck
            ? jsonResponse({ deck }, 200, { ...headers, 'Cache-Control': 'no-store' })
            : libraryError('PPT library entry not found', headers, 404);
        }
        if (!isAdminRequest(request, env)) return libraryError('관리자 비밀번호가 올바르지 않습니다.', headers, 403);
        if (request.method === 'POST') {
          const body = JSON.parse(await request.text());
          if (body.deck?.id !== pptDeck[1]) return libraryError('deck ID does not match', headers);
          return jsonResponse({ deck: await tracker.commitPptDeck(body.deck) }, 200, {
            ...headers,
            'Cache-Control': 'no-store',
          });
        }
        if (request.method === 'DELETE') {
          await tracker.deletePptDeck(pptDeck[1]);
          return jsonResponse({ ok: true }, 200, { ...headers, 'Cache-Control': 'no-store' });
        }
      } catch (error) {
        return libraryError(error, headers);
      }
      return libraryError('not found', headers, 404);
    }

    // Published lyrics for a recognized title. The browser cannot fetch these
    // itself (every lyrics site blocks cross-origin reads), so the proxy does
    // the lookup and returns plain lines for the editor to structure. Only a
    // title crosses the wire — never a URL — and src/lyrics.js will only fetch
    // allowlisted hosts, so this cannot be used to reach arbitrary origins.
    if (request.method === 'GET' && url.pathname === '/lyrics') {
      const title = (url.searchParams.get('title') || '').trim().slice(0, 100);
      if (!title) return jsonResponse({ error: 'missing title' }, 400, headers);

      // Published lyrics do not change, and a conti is opened repeatedly while
      // a deck is built — serve repeats from the edge instead of re-scraping.
      const cacheKey = new Request(`${url.origin}/lyrics?title=${encodeURIComponent(title)}`, {
        method: 'GET',
      });
      const cache = caches.default;
      const cached = await cache.match(cacheKey);
      if (cached) {
        const body = await cached.text();
        return new Response(body, { status: 200, headers: { ...headers, 'Content-Type': 'application/json' } });
      }

      let found = null;
      try {
        found = await fetchWebLyrics(title);
      } catch (error) {
        console.warn('lyrics lookup failed:', error instanceof Error ? error.message : error);
      }
      const payload = found
        ? { title, lines: found.lines, url: found.url, host: found.host }
        : { title, lines: [] };
      const body = JSON.stringify(payload);
      if (found) {
        await cache.put(
          cacheKey,
          new Response(body, {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=604800' },
          }),
        );
      }
      return new Response(body, { status: 200, headers: { ...headers, 'Content-Type': 'application/json' } });
    }

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

    // Shared recognition settings: everyone reads the same model pool
    // and excluded-title list; writes require the 관리자 설정 password.
    if (url.pathname === '/settings') {
      const tracker = usageTracker(env);
      if (request.method === 'GET') {
        let stored = null;
        try {
          stored = tracker ? await tracker.getSharedSettings() : null;
        } catch {
          // Fall through to defaults — reads must never fail the client.
        }
        return jsonResponse(sanitizeSharedSettings(stored), 200, {
          ...headers,
          'Cache-Control': 'no-store',
        });
      }
      if (request.method === 'POST') {
        if (!tracker) {
          return jsonResponse({ error: 'shared settings storage is not configured' }, 503, headers);
        }
        let body;
        try {
          body = JSON.parse(await request.text());
        } catch {
          return jsonResponse({ error: 'invalid JSON body' }, 400, headers);
        }
        if (typeof body?.password !== 'string' || body.password !== adminPassword(env)) {
          return jsonResponse({ error: '관리자 비밀번호가 올바르지 않습니다.' }, 403, headers);
        }
        const settings = sanitizeSharedSettings(body);
        await tracker.setSharedSettings(settings);
        return jsonResponse(settings, 200, { ...headers, 'Cache-Control': 'no-store' });
      }
      return jsonResponse({ error: 'not found' }, 404, headers);
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

    if (url.pathname === '/openrouter' || url.pathname === '/nvidia') {
      // The body is OpenAI-compatible JSON. The client picks the model from
      // the shared model pool, and the Worker pins it to an allowlisted
      // OpenRouter :free vision endpoint before attaching the server key.
      let body;
      try {
        body = JSON.parse(await request.text());
      } catch {
        return jsonResponse({ error: 'invalid JSON body' }, 400, headers);
      }
      const requested = typeof body?.model === 'string' ? body.model : '';
      const route = resolveOpenRouterRoute(requested);
      // No silent substitution: a model outside the free catalog is refused
      // rather than swapped for another one the caller never asked for.
      if (!route) {
        return jsonResponse({ error: `model not allowed: ${requested.slice(0, 100)}` }, 400, headers);
      }
      if (!env.OPENROUTER_API_KEY) {
        return jsonResponse({ error: 'OPENROUTER_API_KEY not configured on the proxy' }, 500, headers);
      }
      body = { ...body, model: route.upstreamModel };
      const startedAt = Date.now();
      const res = await fetch(OPENROUTER_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://shrlak.github.io/ppt/',
          'X-OpenRouter-Title': 'KCCP PPT Generator',
        },
        body: JSON.stringify(body),
      });
      const resBody = await res.text();
      const wallSeconds = Math.max(0, (Date.now() - startedAt) / 1000);
      await recordUsage(env, {
        provider: 'openrouter',
        model: route.upstreamModel,
        success: res.ok,
        wallSeconds,
        ...openAiUsageMetadata(resBody),
      });
      return new Response(resBody, { status: res.status, headers: { ...headers, 'Content-Type': 'application/json' } });
    }

    return jsonResponse({ error: 'not found' }, 404, headers);
  },
};
