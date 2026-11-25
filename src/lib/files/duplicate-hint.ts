/**
 * "You already uploaded this" — for the person uploading, never about anyone else.
 *
 * Archival decision (25.11.2026): two different people sending the same
 * photograph is welcome — each may bring a new angle, story or context — so a
 * contributor is never told that *someone else* holds a file. They are told
 * only about their own double uploads:
 *
 *   batch     the same bytes (SHA-256) twice in this upload, found in the browser
 *   earlier   the same bytes in a record this signed-in user uploaded before
 *             (`items.uploaded_by`), found by /api/uploads/sign
 *
 * Anonymous uploads are never checked against the archive at all: there is no
 * "you" to match, and answering would let anyone ask whether a file is held.
 * Experts still see every archive-wide duplicate in /review (0034), unchanged.
 *
 * Pure and client-safe, so the rules can be tested without a database.
 */

export interface ChecksumMatch {
  item_id: string;
  items: { uploaded_by: string | null; status: string; access: string; category: string | null; deleted_at: string | null } | null;
}

export type DuplicateHint =
  | { kind: 'earlier'; itemId: string; published: boolean }
  | { kind: 'batch' }
  | null;

export function isPublicRecord(item: ChecksumMatch['items']): boolean {
  return Boolean(item && item.status === 'accepted' && item.access === 'public' && item.category && !item.deleted_at);
}

/**
 * The uploader's own earlier record holding these bytes, if any. Rows that are
 * not theirs are ignored even if the query returned them — the filter is
 * applied in SQL and again here. Binned records do not count.
 */
export function earlierUploadHint(matches: ChecksumMatch[], uploaderId: string | null | undefined): DuplicateHint {
  if (!uploaderId) return null;
  const own = matches.filter((m) => m.items && m.items.uploaded_by === uploaderId && !m.items.deleted_at);
  if (!own.length) return null;
  const published = own.find((m) => isPublicRecord(m.items));
  const chosen = published ?? own[0];
  return { kind: 'earlier', itemId: chosen.item_id, published: Boolean(published) };
}

/** Ids of files whose bytes already appeared earlier in this upload (the first copy is not flagged). */
export function batchDuplicates(files: { id: string; checksum?: string | null }[]): Set<string> {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const file of files) {
    if (!file.checksum) continue;
    if (seen.has(file.checksum)) repeated.add(file.id);
    else seen.add(file.checksum);
  }
  return repeated;
}

/** Where the notice links: the public page if published, else the uploader's review page. */
export function earlierUploadHref(hint: Extract<DuplicateHint, { kind: 'earlier' }>): string {
  return hint.published ? `/portal/${hint.itemId}` : `/review/${hint.itemId}`;
}
