export declare const FREE_STORAGE_LIMIT_BYTES: 5000000000;
export declare const STORAGE_SOURCE: string;
export interface StorageSql {
  readonly databaseSize: number;
  exec(query: string): { toArray(): { bytes: number; count?: number }[] };
}
export interface StorageEnvironment {
  USAGE_TRACKER?: { idFromName(name: string): unknown; get(id: unknown): { storageMetrics(): Promise<{ databaseBytes: number }> } };
}
export declare function storagePlan(): { plan: 'workers-free'; limitBytes: number; limitScope: 'account-durable-objects'; source: string };
export declare function measureStorage(sql: StorageSql, env: StorageEnvironment): Promise<ReturnType<typeof storagePlan> & {
  usedBytes: number; usedPercent: number; freecastBytes: number; sharedBytes: number;
  mediaBytes: number; mediaCount: number; libraryBytes: number; checkedAt: number;
  scope: 'church-worker-durable-objects'; accountUsageComplete: false;
}>;
