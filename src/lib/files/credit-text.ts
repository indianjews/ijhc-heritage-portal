import { en, format, type MessageKey } from '@/lib/i18n/messages';

type Translator = (key: MessageKey, vars?: Record<string, string | number>) => string;
const english: Translator = (key, vars) => format(en[key], vars);

export function creditName(value: string | null | undefined, limit?: number): string {
  // Control characters must not introduce lines or override the surrounding bidi text.
  const clean = (value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  const letters = Array.from(clean);
  return limit && letters.length > limit ? letters.slice(0, limit - 1).join('') + '…' : clean;
}

export interface CreditSegment {
  kind: 'collector' | 'source' | 'archive';
  text: string;
  /** The person named in this segment, cleaned; absent for the archive. */
  name?: string;
}

/**
 * The attribution, in parts, so a page can link the names.
 *
 * Who holds the rights is never invented. A named collector is credited with
 * ©, because the uploader said so. Without one, the Center is named as the
 * archive that holds the item — not as its owner: the Terms of Use say
 * copyright stays with whoever holds it, and a contributor only gives the
 * Center permission to keep and publish. (Until 25.11.2026 the default read
 * "© Indian Jewish Heritage Center", which contradicted them.)
 */
export function creditSegments(collector?: string | null, source?: string | null, t: Translator = english, limit?: number): CreditSegment[] {
  const owner = creditName(collector, limit);
  const uploader = creditName(source, limit);
  const segments: CreditSegment[] = [];
  if (owner) segments.push({ kind: 'collector', text: t('credit.collection', { collector: owner }), name: owner });
  if (uploader) segments.push({ kind: 'source', text: t('credit.shared', { source: uploader }), name: uploader });
  segments.push({ kind: 'archive', text: t('credit.center') });
  return segments;
}

export function creditText(collector?: string | null, source?: string | null, t: Translator = english, limit?: number): string {
  return creditSegments(collector, source, t, limit).map((segment) => segment.text).join(' · ');
}

export function escapePango(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
