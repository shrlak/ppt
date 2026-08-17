// An in-memory stand-in for the Durable Object storage the shared proxy runs
// on, so the Worker's routes can be exercised as ordinary functions.
//
// Route behaviour — who may write, what is rejected, what comes back — is the
// part of the proxy most worth testing and the part hardest to check by
// reading. This harness is deliberately small: it implements only the storage
// surface worker/src/index.js actually uses.
import worker, { UsageTracker } from '../../worker/src/index.js';
import { DEFAULT_ADMIN_PASSWORD } from '../../worker/src/config.js';

const ALLOWED_ORIGIN = 'https://shrlak.github.io';

class MemoryStorage {
  private readonly values = new Map<string, unknown>();

  async get(key: string): Promise<unknown> {
    return this.values.get(key);
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string | string[]): Promise<void> {
    for (const one of Array.isArray(key) ? key : [key]) this.values.delete(one);
  }

  async list({ prefix = '' }: { prefix?: string } = {}): Promise<Map<string, unknown>> {
    return new Map(
      [...this.values.entries()].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)),
    );
  }

  /** The real storage runs the callback against itself; so does this one. */
  async transaction<T>(run: (transaction: MemoryStorage) => Promise<T>): Promise<T> {
    return run(this);
  }
}

export interface WorkerHarness {
  env: Record<string, unknown>;
  tracker: InstanceType<typeof UsageTracker>;
  storage: MemoryStorage;
  /** Call the Worker's fetch handler from an allowed origin. */
  fetch(path: string, init?: RequestInit & { admin?: boolean }): Promise<Response>;
}

export function createWorkerHarness(vars: Record<string, unknown> = {}): WorkerHarness {
  const storage = new MemoryStorage();
  const env: Record<string, unknown> = { ...vars };
  const tracker = new UsageTracker({ storage }, env) as InstanceType<typeof UsageTracker>;
  env.USAGE_TRACKER = {
    idFromName: (name: string) => name,
    get: () => tracker,
  };

  return {
    env,
    tracker,
    storage,
    fetch(path, init = {}) {
      const { admin, headers, ...rest } = init as RequestInit & { admin?: boolean };
      return worker.fetch(
        new Request(`https://proxy.test${path}`, {
          ...rest,
          headers: {
            Origin: ALLOWED_ORIGIN,
            ...(admin ? { Authorization: `Bearer ${DEFAULT_ADMIN_PASSWORD}` } : {}),
            ...((headers as Record<string, string>) ?? {}),
          },
        }),
        env,
      );
    },
  };
}
