import { z } from 'zod';
import { youtubeVideoId } from '@/lib/links/youtube';
import { fileKind, validateFile } from '@/lib/files/validate';

/**
 * The rules for one item of a content expert's bulk upload, in one place.
 *
 * Pure and client-safe: the screen uses the same predicates for its inline
 * errors that the route uses to refuse a request, so "the button let me but
 * the server said no" cannot happen for any rule written here. The route's
 * copy is the one that counts.
 *
 * Error messages are message-catalogue keys (`bulk.err.*`), so either side
 * can say them in the reader's language.
 */

/** What the bulk screen takes: images and short videos from the regular allow-list. */
export function bulkFileAccepted(mimeType: string): boolean {
  const kind = fileKind(mimeType);
  return (kind === 'image' || kind === 'video') && validateFile({ mimeType, byteSize: 1 }) === null;
}

/** Video bytes are never sent to the model; everything else readable is queued. */
export function isVideo(mimeType: string): boolean {
  return fileKind(mimeType) === 'video';
}

const YEAR = /^\d{3,4}$/;

/**
 * A year (`1952`) or a range (`1940-1950`, any dash, spaces allowed), no later
 * than this year. Returns the normalized text stored in `items.period`, or
 * null when it is not one of those. Nothing is guessed: "1950s" or "c. 1950"
 * are refused, and the expert can tick "Date unknown" or write it in the notes.
 */
export function parsePeriod(raw: string, now = new Date()): string | null {
  const text = raw.trim();
  if (!text) return null;
  const parts = text.split(/\s*[-–—]\s*/);
  if (parts.length > 2 || !parts.every((p) => YEAR.test(p))) return null;
  const [from, to] = parts.map(Number);
  const thisYear = now.getUTCFullYear();
  if (from > thisYear || (to !== undefined && (to > thisYear || to < from))) return null;
  return to === undefined || to === from ? String(from) : `${from}-${to}`;
}

export type CardField = 'media' | 'youtube' | 'period' | 'credit' | 'collector';
export type CardErrorKey =
  | 'bulk.err.media'
  | 'bulk.err.youtube'
  | 'bulk.err.period'
  | 'bulk.err.periodFormat'
  | 'bulk.err.credit'
  | 'bulk.err.collector';

export interface CardInput {
  fileCount: number;
  youtubeUrl: string;
  period: string;
  periodUnknown: boolean;
  /** null = not answered yet. There is deliberately no default. */
  creditRequired: boolean | null;
  collectorName: string;
}

/** Every rule an item must meet before it is sent, as field -> message key. */
export function cardErrors(card: CardInput, now = new Date()): Partial<Record<CardField, CardErrorKey>> {
  const errors: Partial<Record<CardField, CardErrorKey>> = {};
  const url = card.youtubeUrl.trim();
  if (url && !youtubeVideoId(url)) errors.youtube = 'bulk.err.youtube';
  if (card.fileCount < 1 && !url) errors.media = 'bulk.err.media';
  if (!card.periodUnknown) {
    if (!card.period.trim()) errors.period = 'bulk.err.period';
    else if (!parsePeriod(card.period, now)) errors.period = 'bulk.err.periodFormat';
  }
  if (card.creditRequired === null) errors.credit = 'bulk.err.credit';
  else if (card.creditRequired && !card.collectorName.trim()) errors.collector = 'bulk.err.collector';
  return errors;
}

const BulkFile = z.object({
  path: z.string().min(1).max(400),
  /** Proof the path was minted by /api/uploads/sign. See src/lib/files/grant.ts. */
  grant: z.string().min(1).max(200),
  expiresAt: z.number(),
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(120).refine(bulkFileAccepted, { message: 'bulk.err.fileTypeServer' }),
  byteSize: z.number().int().positive(),
  /** Measured in the browser for audio/video only; images are measured from the bytes on the server. */
  durationMs: z.number().int().positive().nullable().optional(),
});

/** One item, as the route receives it. */
export const BulkItemBody = z
  .object({
    title: z.string().trim().max(200).optional(),
    description: z.string().trim().max(4000).optional(),
    youtubeUrl: z.string().trim().max(2000).optional(),
    /** The video's own title, read by the browser from YouTube's oEmbed. A title candidate only. */
    youtubeTitle: z.string().trim().max(200).optional(),
    period: z.string().trim().max(40).optional(),
    periodUnknown: z.boolean(),
    creditRequired: z.boolean({ message: 'bulk.err.credit' }),
    collectorName: z.string().trim().max(200).optional(),
    consentVersion: z.string().trim().min(1).max(40),
    files: z.array(BulkFile).max(25),
  })
  .superRefine((body, ctx) => {
    const errors = cardErrors({
      fileCount: body.files.length,
      youtubeUrl: body.youtubeUrl ?? '',
      period: body.period ?? '',
      periodUnknown: body.periodUnknown,
      creditRequired: body.creditRequired,
      collectorName: body.collectorName ?? '',
    });
    for (const [field, key] of Object.entries(errors)) {
      ctx.addIssue({ code: 'custom', path: [field === 'collector' ? 'collectorName' : field], message: key });
    }
    if (body.periodUnknown && body.period?.trim()) {
      ctx.addIssue({ code: 'custom', path: ['period'], message: 'bulk.err.periodBoth' });
    }
  });

export type BulkItem = z.infer<typeof BulkItemBody>;

/** What lands on the item, derived from a valid body. Pure. */
export function bulkItemValues(body: BulkItem, now = new Date()) {
  return {
    period: body.periodUnknown ? null : parsePeriod(body.period ?? '', now),
    collectorCreditRequired: body.creditRequired,
    collectorName: body.creditRequired ? body.collectorName!.trim() : null,
    sourceUrl: body.youtubeUrl?.trim() || null,
    contributorDescription: body.description?.trim() || null,
  };
}

/** The file name without its extension, with separators turned into spaces. */
function nameStem(fileName: string): string {
  return fileName.replace(/\.[A-Za-z0-9]{1,10}$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function clip(text: string): string {
  const letters = Array.from(text.replace(/\s+/g, ' ').trim());
  return letters.length > 200 ? letters.slice(0, 199).join('') + '…' : letters.join('');
}

/**
 * A temporary title the expert can refine in the workbench: the one they
 * typed, else the first line of their notes, else the YouTube title, else the
 * first file's name. Always 1-200 characters.
 */
export function deriveTitle(input: {
  title?: string;
  description?: string;
  youtubeTitle?: string;
  fileNames: string[];
  now?: Date;
}): string {
  const candidates = [
    input.title,
    input.description?.split(/\r?\n/).map((line) => line.trim()).find(Boolean),
    input.youtubeTitle,
    input.fileNames[0] ? nameStem(input.fileNames[0]) : undefined,
  ];
  for (const candidate of candidates) {
    const clipped = clip(candidate ?? '');
    if (clipped) return clipped;
  }
  return `Bulk upload ${(input.now ?? new Date()).toISOString().slice(0, 10)}`;
}
