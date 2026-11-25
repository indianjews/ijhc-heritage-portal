/**
 * What a contributor may be told when a file they are uploading is already in
 * the archive (byte-identical: same SHA-256).
 *
 * Pure, so the privacy rule can be tested on its own:
 *
 *   - Only that a match exists, and — if one of the matching records is
 *     published to everyone — that record's id, so the screen can link to a
 *     page anyone could already open.
 *   - Never a title, description, status, or the id of a record that is
 *     pending, rejected, restricted, uncatalogued or in the bin. A match on
 *     such a record reads exactly like a match on nothing published.
 *
 * Binned records do not count as "already in the archive" at all.
 */

export interface ChecksumMatch {
  item_id: string;
  items: { status: string; access: string; category: string | null; deleted_at: string | null } | null;
}

export type DuplicateHint = { publishedId: string | null } | null;

export function isPublicRecord(item: ChecksumMatch['items']): boolean {
  return Boolean(item && item.status === 'accepted' && item.access === 'public' && item.category && !item.deleted_at);
}

export function duplicateHint(matches: ChecksumMatch[]): DuplicateHint {
  const live = matches.filter((m) => m.items && !m.items.deleted_at);
  if (!live.length) return null;
  const published = live.find((m) => isPublicRecord(m.items));
  return { publishedId: published?.item_id ?? null };
}
