// Getting verified corrections to the shared proxy, eventually.
//
// A save must never fail, block, or wait on the network — the user is trying
// to build a slide deck, not train a model. So an explicit save writes the
// library entry immediately and drops a feedback record into a durable local
// queue; the queue drains whenever it can, mirroring how the lyrics library
// already syncs.
//
// Duplicates are collapsed by page and by the exact answer saved, because the
// same song is re-saved constantly while a deck is edited and each duplicate
// would otherwise count as another vote for the models that read it.
import { learningFetch } from './learningClient';
import { ADMIN_PASSWORD } from '../adminAuth';
import type { FeedbackExample } from './feedbackDiff';

const QUEUE_KEY = 'praise-learning-feedback-queue-v1';

/** Bound on the queue, so a long offline stretch cannot fill up storage. */
const MAX_QUEUED = 50;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** What makes two saves the same save: the page, and the exact answer. */
export function feedbackKey(example: Pick<FeedbackExample, 'pageHash' | 'finalHash'>): string {
  return `${example.pageHash}:${example.finalHash}`;
}

export function loadFeedbackQueue(): FeedbackExample[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = JSON.parse(store.getItem(QUEUE_KEY) ?? '[]') as FeedbackExample[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveFeedbackQueue(queue: FeedbackExample[]): void {
  try {
    storage()?.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-MAX_QUEUED)));
  } catch {
    // Private browsing without storage: the record is lost, the save is not.
  }
}

export function clearFeedbackQueue(): void {
  try {
    storage()?.removeItem(QUEUE_KEY);
  } catch {
    // Nothing to clear.
  }
}

/**
 * Queue one verified correction and try to send it.
 *
 * Re-saving the same page with the same answer replaces the queued record
 * rather than adding another: the second save is the same evidence, and
 * counting it twice would inflate every model's sample count.
 */
export function queueFeedback(example: FeedbackExample): void {
  const key = feedbackKey(example);
  const queue = loadFeedbackQueue().filter((candidate) => feedbackKey(candidate) !== key);
  saveFeedbackQueue([...queue, example]);
  void flushFeedbackQueue().catch(() => undefined);
}

let flushPromise: Promise<void> | null = null;

/**
 * Drain the queue to the proxy, oldest first.
 *
 * Stops at the first record the proxy will not take, so a transient failure
 * keeps its place in line instead of losing the rest of the queue. A record
 * the proxy rejects outright is dropped: retrying it forever would block
 * everything behind it.
 */
export async function flushFeedbackQueue(): Promise<void> {
  if (flushPromise) return flushPromise;
  flushPromise = (async () => {
    while (true) {
      const example = loadFeedbackQueue()[0];
      if (!example) return;
      const response = await learningFetch('/learning/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_PASSWORD}` },
        body: JSON.stringify({ example }),
      });
      // No proxy, or it could not be reached: keep the record for next time.
      if (!response) return;
      // 4xx means this record will never be accepted; drop it and continue.
      if (!response.ok && response.status < 400) return;
      saveFeedbackQueue(loadFeedbackQueue().filter((candidate) => candidate.id !== example.id));
    }
  })();
  try {
    await flushPromise;
  } finally {
    flushPromise = null;
  }
}
