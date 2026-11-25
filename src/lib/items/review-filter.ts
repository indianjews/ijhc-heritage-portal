/**
 * Finding things in the review queue, as pure rules (client-safe).
 *
 * An expert who knows Cochin, or ketubot, should be able to see just those.
 * Filtering never reorders: the queue stays oldest first (review-order.ts),
 * only with fewer cards.
 */

export interface QueueFilterable {
  title: string;
  description?: string | null;
  contributor_description?: string | null;
  source?: string | null;
  collector_name?: string | null;
  community?: string | null;
  category?: string | null;
}

export interface QueueFilter {
  text?: string;
  /** A community value, or '' for any. */
  community?: string;
  /** A category value, '' for any, or NONE for "not yet catalogued". */
  category?: string;
}

export const NONE = '__none__';

function fold(text: string): string {
  return text.normalize('NFC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Items matching every part of the filter, in their original order. The text
 * must appear (all of its words, anywhere) in the title, description, the
 * contributor's own notes, the contributor or collector name, or the
 * community — by its value or by the label the expert reads.
 */
export function filterQueue<T extends QueueFilterable>(items: T[], filter: QueueFilter, communityLabel: (value: string) => string = (v) => v): T[] {
  const words = fold(filter.text ?? '').split(' ').filter(Boolean);
  return items.filter((item) => {
    if (filter.community && item.community !== filter.community) return false;
    if (filter.category === NONE ? item.category : filter.category && item.category !== filter.category) return false;
    if (!words.length) return true;
    const haystack = fold([
      item.title, item.description, item.contributor_description, item.source, item.collector_name,
      item.community, item.community ? communityLabel(item.community) : null,
    ].filter(Boolean).join(' \u0001 '));
    return words.every((word) => haystack.includes(word));
  });
}

/** The values present in the queue, for the dropdowns: nothing offered that would empty the list. */
export function queueOptions(items: QueueFilterable[]) {
  const communities = [...new Set(items.map((i) => i.community).filter((c): c is string => Boolean(c)))].sort();
  const categories = [...new Set(items.map((i) => i.category).filter((c): c is string => Boolean(c)))].sort();
  return { communities, categories, uncategorised: items.some((i) => !i.category) };
}
