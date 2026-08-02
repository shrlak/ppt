export interface PurgeSchedule {
  timeZone: string;
  /** 0 = Sunday, matching Date#getDay(). */
  weekday: number;
  /** Local hour, 0-23. */
  hour: number;
}

export interface PurgeDecision {
  purge: boolean;
  /** Local calendar date of this firing; identifies the week already purged. */
  purgeKey: string;
  localTime: string;
  reason: string;
  schedule: PurgeSchedule;
}

export const DEFAULT_PURGE_TIMEZONE: string;
export const DEFAULT_PURGE_HOUR: number;
export const DEFAULT_PURGE_WEEKDAY: number;
export const TOMBSTONE_RETENTION_DAYS: number;

export function zonedParts(
  value?: string | Date,
  timeZone?: string,
): { dateKey: string; weekday: number; hour: number };
export function purgeSchedule(env?: Record<string, string | undefined>): PurgeSchedule;
export function purgeDecision(
  now?: string | Date,
  lastPurgeKey?: string | null,
  env?: Record<string, string | undefined>,
): PurgeDecision;
export function staleTombstoneKeys(
  entries: Iterable<[string, { deletedAt?: string } | undefined]>,
  now?: string | Date,
  retentionDays?: number,
): string[];
