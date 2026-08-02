import { describe, expect, it } from 'vitest';
import { SAVED_FILE_KINDS } from '../../src/lib/storage/deckFileKinds';
import { PPT_FILE_KINDS, matchDeckChunkRoute, matchUploadChunkRoute } from '../../worker/src/library.js';
import {
  DEFAULT_PURGE_TIMEZONE,
  TOMBSTONE_RETENTION_DAYS,
  purgeDecision,
  purgeSchedule,
  staleTombstoneKeys,
  zonedParts,
} from '../../worker/src/purge.js';

describe('shared PPT library chunk routes', () => {
  it('transfers every file kind the client uploads', () => {
    // The client sends one chunk stream per declared kind and fails the whole
    // deck upload if any of them is rejected, so the two lists must not drift.
    expect([...PPT_FILE_KINDS]).toEqual([...SAVED_FILE_KINDS]);
    for (const kind of SAVED_FILE_KINDS) {
      expect(matchUploadChunkRoute(`/libraries/ppt/uploads/upload-1/files/${kind}/chunks/0`)).toEqual({
        uploadId: 'upload-1',
        kind,
        index: 0,
      });
      expect(matchDeckChunkRoute(`/libraries/ppt/deck-1/files/${kind}/chunks/12`)).toEqual({
        deckId: 'deck-1',
        kind,
        index: 12,
      });
    }
  });

  it('carries the wizard inputs snapshot to the server like any other file', () => {
    expect(matchUploadChunkRoute('/libraries/ppt/uploads/upload-1/files/source/chunks/0')).not.toBeNull();
    expect(matchDeckChunkRoute('/libraries/ppt/deck-1/files/source/chunks/0')).not.toBeNull();
  });

  it('rejects unknown kinds, missing indexes and the upload path as a deck ID', () => {
    expect(matchUploadChunkRoute('/libraries/ppt/uploads/upload-1/files/secrets/chunks/0')).toBeNull();
    expect(matchDeckChunkRoute('/libraries/ppt/deck-1/files/pptx/chunks/')).toBeNull();
    expect(matchDeckChunkRoute('/libraries/ppt/uploads/upload-1/files/pptx/chunks/0')).toBeNull();
  });
});

describe('weekly purge schedule', () => {
  const env = { PURGE_TIMEZONE: 'America/New_York', PURGE_HOUR: '17' };

  it('defaults to 5 PM Sunday Eastern and ignores an unusable timezone', () => {
    expect(purgeSchedule({})).toEqual({ timeZone: DEFAULT_PURGE_TIMEZONE, weekday: 0, hour: 17 });
    expect(purgeSchedule({ PURGE_TIMEZONE: 'Not/AZone', PURGE_HOUR: '99' })).toEqual({
      timeZone: DEFAULT_PURGE_TIMEZONE,
      weekday: 0,
      hour: 17,
    });
    expect(purgeSchedule({ PURGE_TIMEZONE: 'Asia/Seoul', PURGE_HOUR: '5', PURGE_WEEKDAY: '3' })).toEqual({
      timeZone: 'Asia/Seoul',
      weekday: 3,
      hour: 5,
    });
  });

  it('reads the local weekday and hour through DST', () => {
    // 2026-07-19 21:00Z is EDT (UTC-4); 2026-11-15 22:00Z is EST (UTC-5).
    expect(zonedParts(new Date('2026-07-19T21:00:00Z'), 'America/New_York')).toEqual({
      dateKey: '2026-07-19',
      weekday: 0,
      hour: 17,
    });
    expect(zonedParts(new Date('2026-11-15T22:00:00Z'), 'America/New_York')).toEqual({
      dateKey: '2026-11-15',
      weekday: 0,
      hour: 17,
    });
  });

  it('purges on the 21:00 UTC firing during EDT and the 22:00 UTC one during EST', () => {
    // Summer: 21:00Z is 5 PM, 22:00Z is 6 PM and must not purge again.
    const summerFirst = purgeDecision(new Date('2026-07-19T21:00:00Z'), null, env);
    expect(summerFirst).toMatchObject({ purge: true, purgeKey: '2026-07-19' });
    expect(purgeDecision(new Date('2026-07-19T22:00:00Z'), summerFirst.purgeKey, env)).toMatchObject({
      purge: false,
      reason: 'already purged this week',
    });

    // Winter: 21:00Z is only 4 PM, so the second firing is the real one.
    expect(purgeDecision(new Date('2026-11-15T21:00:00Z'), null, env)).toMatchObject({
      purge: false,
      reason: 'before the purge hour',
    });
    expect(purgeDecision(new Date('2026-11-15T22:00:00Z'), null, env)).toMatchObject({
      purge: true,
      purgeKey: '2026-11-15',
    });
  });

  it('purges again the following week', () => {
    expect(purgeDecision(new Date('2026-07-26T21:00:00Z'), '2026-07-19', env)).toMatchObject({
      purge: true,
      purgeKey: '2026-07-26',
    });
  });

  it('never purges on another weekday', () => {
    // Sunday 5 PM Eastern is already Monday in UTC-facing schedules elsewhere;
    // the decision is local-time only.
    expect(purgeDecision(new Date('2026-07-22T21:00:00Z'), null, env)).toMatchObject({
      purge: false,
      reason: 'not the purge weekday',
    });
  });

  it('honours a different timezone for the same 5 PM rule', () => {
    const seoul = { PURGE_TIMEZONE: 'Asia/Seoul', PURGE_HOUR: '17' };
    // 2026-07-19 08:00Z is 17:00 Sunday in Seoul (UTC+9).
    expect(purgeDecision(new Date('2026-07-19T08:00:00Z'), null, seoul)).toMatchObject({ purge: true });
    expect(purgeDecision(new Date('2026-07-19T07:00:00Z'), null, seoul)).toMatchObject({ purge: false });
  });
});

describe('deletion tombstone retention', () => {
  const now = new Date('2026-07-19T21:00:00Z');
  const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

  it('keeps recent tombstones so offline devices still drop their cached deck', () => {
    const entries: [string, { deletedAt?: string }][] = [
      ['library:ppt:deleted:fresh', { deletedAt: now.toISOString() }],
      ['library:ppt:deleted:recent', { deletedAt: daysAgo(TOMBSTONE_RETENTION_DAYS - 1) }],
      ['library:ppt:deleted:old', { deletedAt: daysAgo(TOMBSTONE_RETENTION_DAYS + 1) }],
      ['library:ppt:deleted:corrupt', {}],
    ];
    expect(staleTombstoneKeys(entries, now)).toEqual(['library:ppt:deleted:old', 'library:ppt:deleted:corrupt']);
  });
});
