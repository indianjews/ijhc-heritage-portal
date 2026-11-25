import { describe, expect, it } from 'vitest';
import { decideQueue, pacificDayStart, queueSettings, readingLanguage } from '@/lib/items/ai-queue-policy';

/** When the quiet-hours queue may spend model calls. Pure; no database. */

const settings = queueSettings({});

describe('queueSettings', () => {
  it('defaults to a twenty-reading day with eight kept for people', () => {
    expect(settings).toMatchObject({ dailyBudget: 20, reserve: 8, perRun: 4, busyThreshold: 2, recentWindowMs: 20 * 60_000 });
  });

  it('reads overrides and ignores nonsense', () => {
    expect(queueSettings({ AI_DAILY_BUDGET: '1500', AI_QUEUE_RESERVE: '100', AI_QUEUE_PER_RUN: '6', AI_QUEUE_BUSY_THRESHOLD: '5' }))
      .toMatchObject({ dailyBudget: 1500, reserve: 100, perRun: 6, busyThreshold: 5 });
    expect(queueSettings({ AI_QUEUE_PER_RUN: '50', AI_DAILY_BUDGET: 'lots', AI_QUEUE_RESERVE: '-1', AI_QUEUE_BUSY_THRESHOLD: '0' }))
      .toMatchObject({ perRun: 4, dailyBudget: 20, reserve: 8, busyThreshold: 2 });
  });
});

describe('decideQueue', () => {
  it('runs a full chunk on a quiet night with room to spare', () => {
    expect(decideQueue({ recentLive: 0, usedToday: 3, settings })).toEqual({ action: 'run', allowance: 4 });
  });

  it('never takes more than the room above the reserve', () => {
    expect(decideQueue({ recentLive: 0, usedToday: 10, settings })).toEqual({ action: 'run', allowance: 2 });
  });

  it('skips when the reserve would be touched', () => {
    expect(decideQueue({ recentLive: 0, usedToday: 12, settings })).toEqual({ action: 'skip', reason: 'quota_reserve' });
    expect(decideQueue({ recentLive: 0, usedToday: 40, settings })).toEqual({ action: 'skip', reason: 'quota_reserve' });
  });

  it('skips when people are using the archive, before looking at the quota', () => {
    expect(decideQueue({ recentLive: 2, usedToday: 0, settings })).toEqual({ action: 'skip', reason: 'busy' });
    expect(decideQueue({ recentLive: 1, usedToday: 0, settings })).toEqual({ action: 'run', allowance: 4 });
    expect(decideQueue({ recentLive: 9, usedToday: 40, settings })).toEqual({ action: 'skip', reason: 'busy' });
  });

  it('can be switched off', () => {
    expect(decideQueue({ recentLive: 0, usedToday: 0, settings: { ...settings, perRun: 0 } })).toEqual({ action: 'skip', reason: 'disabled' });
  });
});

describe('pacificDayStart', () => {
  it('is 08:00 UTC in winter (PST) and 07:00 UTC in summer (PDT)', () => {
    expect(pacificDayStart(new Date('2026-11-25T23:30:00Z')).toISOString()).toBe('2026-11-25T08:00:00.000Z');
    expect(pacificDayStart(new Date('2026-07-01T23:30:00Z')).toISOString()).toBe('2026-07-01T07:00:00.000Z');
  });

  it('belongs to the previous Pacific day before the reset', () => {
    // 05:00 UTC is still the evening before in California.
    expect(pacificDayStart(new Date('2026-11-25T05:00:00Z')).toISOString()).toBe('2026-11-24T08:00:00.000Z');
  });

  it('handles the DST change days', () => {
    // 2026-03-08: clocks spring forward at 02:00 local; midnight was still PST.
    expect(pacificDayStart(new Date('2026-03-08T20:00:00Z')).toISOString()).toBe('2026-03-08T08:00:00.000Z');
    // 2026-11-01: clocks fall back at 02:00 local; midnight was still PDT.
    expect(pacificDayStart(new Date('2026-11-01T20:00:00Z')).toISOString()).toBe('2026-11-01T07:00:00.000Z');
  });
});

describe('readingLanguage', () => {
  it('names the interface languages as the prompt expects', () => {
    expect(readingLanguage('he')).toBe('Hebrew');
    expect(readingLanguage('en')).toBe('English');
    expect(readingLanguage('xx')).toBeUndefined();
    expect(readingLanguage(null)).toBeUndefined();
  });
});
