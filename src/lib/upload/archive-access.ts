import type { Profile } from '@/lib/types';

/**
 * Who may use /archive-upload, as pure rules (decision 26.11.2026,
 * docs/decisions-archive-upload.md). The database function
 * can_archive_upload() (migration 0043) is the authority the route and proxy
 * ask; this mirrors it for rendering, so a menu and a page agree with it.
 *
 *   volunteer, admin   always
 *   pending            only on a day between archive_upload_from and
 *                      archive_upload_until, inclusive, Israel calendar
 *   anyone else        never
 *
 * A window opens this screen and its upload route, and nothing else.
 */

type WindowFields = Pick<Profile, 'role'> & { archive_upload_from?: string | null; archive_upload_until?: string | null };

/** Today's date in Israel, YYYY-MM-DD — the calendar the Center works by. */
export function israelToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export type WindowState = 'none' | 'scheduled' | 'active' | 'ended';

/** Where a granted window stands on a given day. ISO dates compare as strings. */
export function windowState(profile: Pick<WindowFields, 'archive_upload_from' | 'archive_upload_until'>, today: string): WindowState {
  const from = profile.archive_upload_from;
  const until = profile.archive_upload_until;
  if (!from || !until) return 'none';
  if (today < from) return 'scheduled';
  if (today > until) return 'ended';
  return 'active';
}

export type ArchiveAccess = 'expert' | 'window' | null;

export function archiveUploadAccess(profile: WindowFields | null | undefined, today: string): ArchiveAccess {
  if (!profile) return null;
  if (profile.role === 'volunteer' || profile.role === 'admin') return 'expert';
  if (profile.role === 'pending' && windowState(profile, today) === 'active') return 'window';
  return null;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
function realDay(day: string): boolean {
  if (!ISO_DAY.test(day)) return false;
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
}

export type WindowInputError = 'accounts.window.err.both' | 'accounts.window.err.date' | 'accounts.window.err.order';

/** An administrator's from/until input: both set (from <= until) or both cleared. */
export function validateWindow(from: string | null, until: string | null): WindowInputError | null {
  if (!from && !until) return null;
  if (!from || !until) return 'accounts.window.err.both';
  if (!realDay(from) || !realDay(until)) return 'accounts.window.err.date';
  if (from > until) return 'accounts.window.err.order';
  return null;
}
