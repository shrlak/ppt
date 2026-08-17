import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearFeedbackQueue,
  feedbackKey,
  flushFeedbackQueue,
  loadFeedbackQueue,
  queueFeedback,
} from '../../src/lib/learning/feedbackQueue';
import type { FeedbackExample } from '../../src/lib/learning/feedbackDiff';
import { createWorkerHarness } from '../support/workerHarness';

/** A localStorage stand-in, since these tests run in Node. */
function installStorage(): void {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  });
}

/** A stand-in for a real SHA-256: the proxy only accepts lowercase hex. */
const hash = (seed: string) =>
  [...seed].map((character) => (character.codePointAt(0)! % 16).toString(16)).join('').padEnd(64, '0');

function example(pageHash: string, revision: number): FeedbackExample {
  return {
    id: `${pageHash}-${revision}-${Math.random().toString(36).slice(2)}`,
    pageHash: hash(pageHash),
    // The saved answer is what makes two saves the same save, so the same
    // revision must hash the same.
    finalHash: hash(`final${revision}`),
    createdAt: '2026-08-14T00:00:00.000Z',
    observations: [
      { attempt: { engine: 'openrouter', model: 'nvidia/nemotron-nano-12b-v2-vl' }, latencyMs: 900 },
    ],
    baseline: { order: ['I', 'V'], sections: [{ label: 'V', lines: ['가나다라 마바사'] }] },
    final: { order: ['I', 'V'], sections: [{ label: 'V', lines: ['가나다라 마바사 아자차'] }] },
    webCandidates: [],
    diff: {
      titleChanged: false,
      artistChanged: false,
      keyChanged: false,
      orderChanged: false,
      sectionChanges: [{ label: 'V', labelChanged: false, changedLineIndexes: [0] }],
    },
    verification: 'edited',
    evaluations: [
      {
        modelKey: 'openrouter:nvidia/nemotron-nano-12b-v2-vl',
        title: 1,
        order: 1,
        lyrics: 0.8,
        success: true,
        latencyMs: 900,
      },
    ],
  };
}

beforeEach(() => {
  installStorage();
  clearFeedbackQueue();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('feedbackQueue', () => {
  it('coalesces repeated saves of the same page and version', () => {
    queueFeedback(example('page-hash', 2));
    queueFeedback(example('page-hash', 2));
    expect(loadFeedbackQueue()).toHaveLength(1);
  });

  it('keeps a genuinely different answer for the same page', () => {
    queueFeedback(example('page-hash', 2));
    queueFeedback(example('page-hash', 3));
    expect(loadFeedbackQueue()).toHaveLength(2);
  });

  it('keeps the same answer saved from a different page apart', () => {
    queueFeedback(example('page-one', 2));
    queueFeedback(example('page-two', 2));
    expect(loadFeedbackQueue()).toHaveLength(2);
  });

  it('keys a record by the page and the exact answer saved', () => {
    const first = example('page-hash', 2);
    expect(feedbackKey(first)).toBe(`${first.pageHash}:${first.finalHash}`);
  });

  it('survives a storage read that returns nonsense', () => {
    localStorage.setItem('praise-learning-feedback-queue-v1', '{not json');
    expect(loadFeedbackQueue()).toEqual([]);
  });

  it('holds records when there is no proxy to send them to', async () => {
    queueFeedback(example('page-hash', 2));
    await flushFeedbackQueue();
    // Nothing was sent, so nothing may be dropped — the save still happened.
    expect(loadFeedbackQueue()).toHaveLength(1);
  });
});

describe('the proxy side of a verified correction', () => {
  it('stores one record and treats a repeat as a duplicate', async () => {
    const harness = createWorkerHarness();
    const post = (body: unknown) =>
      harness.fetch('/learning/feedback', { method: 'POST', admin: true, body: JSON.stringify(body) });

    const first = await post({ example: example('page-hash', 2) });
    expect(await first.json()).toMatchObject({ stored: true, duplicate: false });

    // A deck is re-saved constantly while it is edited; counting the same
    // evidence twice would inflate every model's sample count.
    const again = await post({ example: example('page-hash', 2) });
    expect(await again.json()).toMatchObject({ stored: false, duplicate: true });

    const stored = await harness.storage.list({ prefix: 'learning:feedback:' });
    expect(stored.size).toBe(1);

    // The duplicate must not have counted the model a second time.
    const models = (await (await harness.fetch('/learning/models')).json()) as {
      models: { samples: number }[];
    };
    expect(models.models).toHaveLength(1);
    expect(models.models[0].samples).toBe(1);
  });

  it('refuses a correction without the administrator password', async () => {
    const harness = createWorkerHarness();
    const response = await harness.fetch('/learning/feedback', {
      method: 'POST',
      body: JSON.stringify({ example: example('page-hash', 2) }),
    });
    expect(response.status).toBe(403);
    expect((await harness.storage.list({ prefix: 'learning:feedback:' })).size).toBe(0);
  });

  it('rejects a record with no usable page hash or saved lyrics', async () => {
    const harness = createWorkerHarness();
    const post = (body: unknown) =>
      harness.fetch('/learning/feedback', { method: 'POST', admin: true, body: JSON.stringify(body) });

    expect((await post({ example: { ...example('p', 1), pageHash: 'not-a-hash' } })).status).toBe(400);
    expect(
      (await post({ example: { ...example('page-hash', 1), final: { order: [], sections: [] } } })).status,
    ).toBe(400);
    expect((await post({ example: { ...example('page-hash', 1), verification: 'draft' } })).status).toBe(400);
  });

  it('counts memory contributions and serves them back for the next run', async () => {
    const harness = createWorkerHarness();
    const withMemory = (revision: number) => ({
      ...example('page-hash', revision),
      memory: {
        aliases: [{ from: '은해의노래', to: '은혜의 노래' }],
        corrections: [{ before: '실력이', after: '능력이', contextBefore: '살아내는', contextAfter: '' }],
        examples: [{ before: '살아내는 실력이', after: '살아내는 능력이', title: '은혜의 노래', label: 'V' }],
      },
    });

    await harness.fetch('/learning/feedback', {
      method: 'POST',
      admin: true,
      body: JSON.stringify({ example: withMemory(1) }),
    });
    await harness.fetch('/learning/feedback', {
      method: 'POST',
      admin: true,
      body: JSON.stringify({ example: withMemory(2) }),
    });

    const memory = (await (await harness.fetch('/learning/memory?title=은혜의 노래')).json()) as {
      titleAliases: { support: number }[];
      corrections: { support: number; seen: number }[];
      examples: unknown[];
    };
    expect(memory.titleAliases[0]).toMatchObject({ to: '은혜의 노래', support: 2 });
    expect(memory.corrections[0]).toMatchObject({ support: 2, seen: 2 });
    // Examples are capped hard: the prompt is a nudge, not a lyric store.
    expect(memory.examples.length).toBeLessThanOrEqual(3);
  });

  it('resets an alias count when a later correction disagrees with it', async () => {
    const harness = createWorkerHarness();
    const withAlias = (revision: number, to: string) => ({
      ...example('page-hash', revision),
      memory: { aliases: [{ from: '은해의노래', to }], corrections: [], examples: [] },
    });
    for (const [revision, to] of [
      [1, '은혜의 노래'],
      [2, '은혜의 노래'],
      [3, '전혀 다른 제목'],
    ] as const) {
      await harness.fetch('/learning/feedback', {
        method: 'POST',
        admin: true,
        body: JSON.stringify({ example: withAlias(revision, to) }),
      });
    }
    const memory = (await (await harness.fetch('/learning/memory')).json()) as {
      titleAliases: { to: string; support: number }[];
    };
    // Two users disagreeing is not two votes for either answer.
    expect(memory.titleAliases[0]).toMatchObject({ to: '전혀 다른 제목', support: 1 });
  });

  it('keeps a stored correction out of the public model dashboard', async () => {
    const harness = createWorkerHarness();
    await harness.fetch('/learning/feedback', {
      method: 'POST',
      admin: true,
      body: JSON.stringify({ example: example('page-hash', 2) }),
    });
    const models = await (await harness.fetch('/learning/models')).text();
    expect(models).not.toContain('가나다라');
  });
});
