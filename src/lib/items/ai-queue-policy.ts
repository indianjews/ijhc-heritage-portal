/**
 * When the quiet-hours queue may spend model calls, as pure rules.
 *
 * The free tier allows about twenty readings a day per model (CODEBASE-GUIDE
 * §2), and a contributor uploading a family photograph at 21:00 must never be
 * told the archive is out of readings because an expert queued forty items
 * that afternoon. So the queue only reads when two things are true:
 *
 *   nobody is using it   fewer than `busyThreshold` live readings in the last
 *                        twenty minutes (queued rows are not "live")
 *   there is room left   today's usage plus this run stays at or below
 *                        `dailyBudget - reserve`; the reserve is for people
 *
 * "Today" is the US Pacific day, because that is when Gemini's free-tier
 * quota resets (see scripts/quota.mjs). Counted from the archive's own rows,
 * as that script does: one call per ai_analyses row.
 */

export interface QueueSettings {
  /** Readings the archive assumes it may make per Pacific day. */
  dailyBudget: number;
  /** Of those, kept back for live contributors. */
  reserve: number;
  /** At most this many queued readings per run. */
  perRun: number;
  /** This many live readings in the window means someone is using the archive. */
  busyThreshold: number;
  /** How far back "recent" looks. */
  recentWindowMs: number;
}

function int(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw?.trim()) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** Settings from the environment; every variable is optional. Out-of-range values fall back. */
export function queueSettings(env: Record<string, string | undefined> = process.env): QueueSettings {
  return {
    dailyBudget: int(env.AI_DAILY_BUDGET, 20, 0, 10_000),
    reserve: int(env.AI_QUEUE_RESERVE, 8, 0, 10_000),
    perRun: int(env.AI_QUEUE_PER_RUN, 4, 0, 10),
    busyThreshold: int(env.AI_QUEUE_BUSY_THRESHOLD, 2, 1, 1_000),
    recentWindowMs: 20 * 60_000,
  };
}

export type QueueDecision =
  | { action: 'run'; allowance: number }
  | { action: 'skip'; reason: 'busy' | 'quota_reserve' | 'disabled' };

export function decideQueue(input: { recentLive: number; usedToday: number; settings: QueueSettings }): QueueDecision {
  const { recentLive, usedToday, settings } = input;
  if (settings.perRun === 0) return { action: 'skip', reason: 'disabled' };
  // People first: a reading in progress now is a contributor waiting for it.
  if (recentLive >= settings.busyThreshold) return { action: 'skip', reason: 'busy' };
  const room = settings.dailyBudget - settings.reserve - usedToday;
  if (room <= 0) return { action: 'skip', reason: 'quota_reserve' };
  return { action: 'run', allowance: Math.min(settings.perRun, room) };
}

/**
 * Midnight in Los Angeles at the start of the Pacific day containing `now`,
 * as a UTC instant. Midnight there is 07:00 or 08:00 UTC depending on DST;
 * both are tried against the clock rather than a DST table being assumed.
 */
export function pacificDayStart(now: Date): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const [y, m, d] = [Number(parts.year), Number(parts.month), Number(parts.day)];
  for (const offsetHours of [7, 8]) {
    const candidate = new Date(Date.UTC(y, m - 1, d, offsetHours));
    const hour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23' }).format(candidate);
    if (Number(hour) === 0 && candidate.getTime() <= now.getTime()) return candidate;
  }
  // Unreachable for real dates; the earlier of the two is the safe answer (counts more).
  return new Date(Date.UTC(y, m - 1, d, 7));
}

/** The archive's interface language codes, as the reading prompt names them. */
const READING_LANGUAGE: Record<string, string> = {
  en: 'English', he: 'Hebrew', hi: 'Hindi', mr: 'Marathi', ml: 'Malayalam',
};

export function readingLanguage(code: string | null | undefined): string | undefined {
  return code ? READING_LANGUAGE[code] : undefined;
}
