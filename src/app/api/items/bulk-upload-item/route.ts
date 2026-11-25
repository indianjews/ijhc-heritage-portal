import { NextRequest } from 'next/server';
import { getCurrentVolunteer } from '@/lib/supabase/server';
import { getMessages } from '@/lib/i18n';
import { fail, invalid, ok, readJson, unexpected } from '@/lib/api';
import { verifyGrant } from '@/lib/files/grant';
import { createItem } from '@/lib/items/mutations';
import { BulkItemBody, bulkItemValues, deriveTitle, isVideo } from '@/lib/items/bulk-upload';
import { clientKey, rateLimit } from '@/lib/rate-limit';

/**
 * One item of a content expert's bulk upload (/review/bulk-upload).
 *
 * The screen sends items one at a time, so no request carries more than one
 * item's files and none comes near the platform's time limit.
 *
 * What this route decides, whatever the browser sent:
 *   - only an approved content expert or administrator may call it
 *     (the page and the proxy check too; RLS is not involved because, like
 *     every submission, the write goes through the service role in createItem)
 *   - every file was minted for this caller by /api/uploads/sign (the grant)
 *   - status `pending`, category NULL, `uploaded_by` = the expert
 *   - no model call now: each image's and PDF's reading is `queued` for the
 *     quiet-hours cron; video files get no reading at all — their bytes are never sent
 */
/** createItem reads each stored file back to compute its SHA-256 server-side. */
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const { t, language } = await getMessages();
  try {
    const expert = await getCurrentVolunteer();
    if (!expert) return fail(401, 'unauthenticated', t('review3.signIn'));

    // Generous for a person working through a box of photographs; a ceiling for a script.
    const limit = rateLimit(`bulk-upload:${expert.id}:${clientKey(request)}`, { limit: 120, windowMs: 10 * 60_000 });
    if (!limit.allowed) return fail(429, 'rate_limited', t('err.tooManySubmissions', { seconds: limit.retryAfterSeconds }));

    const parsed = BulkItemBody.safeParse(await readJson(request));
    if (!parsed.success) return invalid(parsed.error);
    const body = parsed.data;

    if (body.files.some((file) => !verifyGrant(file.path, file.expiresAt, file.grant))) {
      return fail(403, 'forbidden', t('err.oneUploadNotOurs'));
    }

    const values = bulkItemValues(body);
    const item = await createItem({
      uploadedBy: expert.id,
      contributorLanguage: language.code,
      title: deriveTitle({
        title: body.title,
        description: body.description,
        youtubeTitle: body.youtubeTitle,
        fileNames: body.files.map((f) => f.fileName),
      }),
      source: null,
      sourceUrl: values.sourceUrl,
      contributorEmail: null,
      contributorFullName: null,
      consentVersion: body.consentVersion,
      contributorDescription: values.contributorDescription,
      contributorKeywords: [],
      contributorFields: [],
      collectorName: values.collectorName,
      collectorCreditRequired: values.collectorCreditRequired,
      period: values.period,
      files: body.files.map((file) => ({
        storagePath: file.path,
        fileName: file.fileName,
        mimeType: file.mimeType,
        byteSize: file.byteSize,
        // Images and PDFs are measured from the bytes when they are read; never guessed here.
        width: null,
        height: null,
        durationMs: file.durationMs ?? null,
        previewPath: null,
        analysis: null,
        analysisError: null,
        analysisQueued: !isVideo(file.mimeType),
        noAnalysis: isVideo(file.mimeType),
      })),
    });

    return ok({ id: item.id, title: item.title }, { status: 201 });
  } catch (error) {
    // 22P02: the enum does not hold `queued` yet — migration 0041 has not been applied.
    if ((error as { code?: string } | null)?.code === '22P02') {
      return fail(503, 'migration_required', t('bulk.err.migration'));
    }
    return unexpected(error, '/api/items/bulk-upload-item');
  }
}
