// Weekly cleanup schedule for the shared PPT 라이브러리.
//
// The team keeps one week of material on the server at a time: the deck for
// the coming Sunday is built during the week, used that morning, and every
// server copy is wiped Sunday at 5 PM local time so the next week starts from
// an empty shelf. Cloudflare cron triggers only speak UTC, so wrangler.toml
// wakes the Worker at *both* UTC hours that can be 5 PM Eastern (21:00 during
// EDT, 22:00 during EST) and the helpers here decide which firing is the real
// one — DST never moves the purge off 5 PM, and the week key keeps the second
// firing from purging twice.
//
// Side-effect free on purpose: the Worker and its unit tests share this file.

export const DEFAULT_PURGE_TIMEZONE = 'America/New_York';
/** 17:00 local, i.e. 5 PM. */
export const DEFAULT_PURGE_HOUR = 17;
/** 0 = Sunday, matching Date#getDay(). */
export const DEFAULT_PURGE_WEEKDAY = 0;
/**
 * How long a deletion tombstone outlives the file it stands for. A device
 * that was offline during the purge must still learn the deck is gone rather
 * than upload its cached copy back, so tombstones are kept far longer than
 * any plausible offline stretch before they are swept up.
 */
export const TOMBSTONE_RETENTION_DAYS = 90;

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function formatterFor(timeZone) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
    });
  } catch {
    // An unusable PURGE_TIMEZONE must not stop the purge from ever running.
    return null;
  }
}

/** Local calendar date, weekday (0-6) and hour (0-23) in `timeZone`. */
export function zonedParts(value = new Date(), timeZone = DEFAULT_PURGE_TIMEZONE) {
  const date = value instanceof Date ? value : new Date(value);
  const formatter = formatterFor(timeZone) ?? formatterFor(DEFAULT_PURGE_TIMEZONE);
  const parts = formatter.formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  // hour12:false renders midnight as '24' in some ICU builds.
  const hour = Number(part('hour'));
  return {
    dateKey: `${part('year')}-${part('month')}-${part('day')}`,
    weekday: WEEKDAYS[part('weekday')] ?? -1,
    hour: Number.isFinite(hour) ? hour % 24 : -1,
  };
}

/** When the purge runs, from the Worker vars (with the defaults above). */
export function purgeSchedule(env = {}) {
  const requested = typeof env.PURGE_TIMEZONE === 'string' ? env.PURGE_TIMEZONE.trim() : '';
  const hour = Number(env.PURGE_HOUR);
  const weekday = Number(env.PURGE_WEEKDAY);
  return {
    timeZone: requested && formatterFor(requested) ? requested : DEFAULT_PURGE_TIMEZONE,
    weekday: Number.isInteger(weekday) && weekday >= 0 && weekday <= 6 ? weekday : DEFAULT_PURGE_WEEKDAY,
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_PURGE_HOUR,
  };
}

/**
 * Whether this cron firing is the weekly purge. `lastPurgeKey` is the local
 * date of the last scheduled purge, so the extra DST firing an hour later —
 * and any retry — is recognised as the same week and skipped.
 */
export function purgeDecision(now = new Date(), lastPurgeKey = null, env = {}) {
  const schedule = purgeSchedule(env);
  const { dateKey, weekday, hour } = zonedParts(now, schedule.timeZone);
  const localTime = `${dateKey} ${String(hour).padStart(2, '0')}:00 ${schedule.timeZone}`;
  const decision = { purgeKey: dateKey, localTime, schedule };
  if (weekday !== schedule.weekday) return { ...decision, purge: false, reason: 'not the purge weekday' };
  if (hour < schedule.hour) return { ...decision, purge: false, reason: 'before the purge hour' };
  if (dateKey === lastPurgeKey) return { ...decision, purge: false, reason: 'already purged this week' };
  return { ...decision, purge: true, reason: 'scheduled weekly purge' };
}

/** Tombstone keys old enough to sweep, from a `storage.list()` result. */
export function staleTombstoneKeys(entries, now = new Date(), retentionDays = TOMBSTONE_RETENTION_DAYS) {
  const reference = now instanceof Date ? now : new Date(now);
  const cutoff = reference.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const stale = [];
  for (const [key, value] of entries) {
    const deletedAt = new Date(value?.deletedAt ?? '').getTime();
    if (!Number.isFinite(deletedAt) || deletedAt < cutoff) stale.push(key);
  }
  return stale;
}
