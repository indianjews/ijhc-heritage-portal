import { z } from 'zod';
import { BulkFile, cardErrors, parsePeriod } from '@/lib/items/bulk-upload';
import { MAX_SIDECAR_CHARS } from './archive-pairing';

/**
 * One item of an archive upload, as POST /api/items/archive-upload receives
 * it. Client-safe: the screen checks the batch fields with the same rules
 * (`cardErrors`) before sending, so the two cannot disagree.
 *
 * The batch fields (dating, copyright, consent) are the same for every item
 * of a batch; each request still carries them, one item per request.
 */
export const ArchiveItemBody = z
  .object({
    /** The group's name from its files (e.g. "wedding_1954"); the item's working title. */
    name: z.string().trim().min(1).max(200),
    /** The sidecar .txt, when there is one. */
    description: z.string().max(MAX_SIDECAR_CHARS).optional(),
    /** True when a .txt describes the item: no AI reading is queued. */
    skipAi: z.boolean(),
    period: z.string().trim().max(40).optional(),
    periodUnknown: z.boolean(),
    creditRequired: z.boolean({ message: 'bulk.err.credit' }),
    collectorName: z.string().trim().max(200).optional(),
    consentVersion: z.string().trim().min(1).max(40),
    files: z.array(BulkFile).min(1).max(50),
  })
  .superRefine((body, ctx) => {
    const errors = cardErrors({
      fileCount: body.files.length, youtubeUrl: '', period: body.period ?? '', periodUnknown: body.periodUnknown,
      creditRequired: body.creditRequired, collectorName: body.collectorName ?? '',
    });
    for (const [field, key] of Object.entries(errors)) {
      ctx.addIssue({ code: 'custom', path: [field === 'collector' ? 'collectorName' : field], message: key });
    }
    if (body.periodUnknown && body.period?.trim()) ctx.addIssue({ code: 'custom', path: ['period'], message: 'bulk.err.periodBoth' });
    // Skipping the reading is only justified by a description to read instead.
    if (body.skipAi && !body.description?.trim()) ctx.addIssue({ code: 'custom', path: ['description'], message: 'archive.err.noText' });
  });

export type ArchiveItem = z.infer<typeof ArchiveItemBody>;

/** The item's dating and copyright, from a valid body. Pure. */
export function archiveItemValues(body: ArchiveItem, now = new Date()) {
  return {
    period: body.periodUnknown ? null : parsePeriod(body.period ?? '', now),
    collectorCreditRequired: body.creditRequired,
    collectorName: body.creditRequired ? body.collectorName!.trim() : null,
    contributorDescription: body.description?.trim() || null,
  };
}
