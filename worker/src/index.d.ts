// Type surface of the shared proxy, for the tests that exercise its routes
// (see tests/support/workerHarness.ts). The Worker itself is plain JS and runs
// on Cloudflare, so this only has to describe what a caller can reach.
import type { LyricsLibraryEntry, PptDeckMetadata, PptFiles } from './library.js';
import type { ModelEvaluation } from './modelStats.js';

export interface DurableObjectStorageLike {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string | string[]): Promise<void>;
  list(options?: { prefix?: string }): Promise<Map<string, unknown>>;
  transaction<T>(run: (transaction: DurableObjectStorageLike) => Promise<T>): Promise<T>;
}

export declare class UsageTracker {
  constructor(ctx: { storage: DurableObjectStorageLike }, env: Record<string, unknown>);
  record(rawEvent: unknown): Promise<unknown>;
  records(): Promise<unknown[]>;
  getSharedSettings(): Promise<unknown>;
  setSharedSettings(value: unknown): Promise<unknown>;
  lyricsLibrary(): Promise<{ entries: LyricsLibraryEntry[]; deletedTitles: string[] }>;
  mergeLyricsLibrary(rawEntries: unknown): Promise<{ entries: LyricsLibraryEntry[]; deletedTitles: string[] }>;
  upsertLyricsEntry(rawEntry: unknown): Promise<LyricsLibraryEntry>;
  deleteLyricsEntry(title: unknown): Promise<void>;
  modelStats(): Promise<Record<string, unknown>[]>;
  recordMemoryContribution(raw: unknown): Promise<void>;
  corpusManifests(): Promise<Record<string, unknown>[]>;
  corpusStatus(): Promise<Record<string, number>>;
  putCorpusManifest(rawManifest: unknown): Promise<Record<string, unknown>>;
  putCorpusChunk(id: string, index: number, data: ArrayBuffer): Promise<void>;
  getCorpusChunk(id: string, index: number): Promise<ArrayBuffer | null>;
  deleteCorpusRecord(id: string): Promise<void>;
  markCorpusExported(
    ids: unknown,
    at?: string,
  ): Promise<{ marked: number; status: Record<string, number> }>;
  learningMemory(title?: string): Promise<{
    titleAliases: unknown[];
    corrections: unknown[];
    examples: unknown[];
  }>;
  recordFeedback(
    rawExample: unknown,
  ): Promise<{ stored: boolean; duplicate: boolean; modelStats: Record<string, unknown>[] }>;
  recordModelEvaluation(
    rawEvaluations: ModelEvaluation[] | unknown,
    at?: string,
  ): Promise<Record<string, unknown>[]>;
  pptLibrary(): Promise<{ decks: PptDeckMetadata[]; deletedIds: string[] }>;
  getPptDeck(id: unknown): Promise<PptDeckMetadata | null>;
  getPptChunk(id: unknown, kind: keyof PptFiles, index: number): Promise<ArrayBuffer | null>;
  startPptUpload(rawUpload: unknown): Promise<unknown>;
  putPptChunk(uploadId: string, kind: keyof PptFiles, index: number, data: ArrayBuffer): Promise<void>;
  commitPptDeck(rawDeck: unknown): Promise<PptDeckMetadata>;
  deletePptDeck(id: unknown): Promise<void>;
  purgePptLibrary(options?: { purgeKey?: string | null; at?: string; trigger?: string }): Promise<unknown>;
  lastPptPurge(): Promise<unknown>;
  prunePptTombstones(now: Date): Promise<number>;
}

declare const worker: {
  fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
  scheduled(
    controller: { scheduledTime?: number },
    env: Record<string, unknown>,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<void>;
};

export default worker;
