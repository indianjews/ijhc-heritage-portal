import { NextRequest } from 'next/server';
import { getMessages } from '@/lib/i18n';
import { fail, invalid, ok, readJson, unexpected } from '@/lib/api';
import { verifyGrant } from '@/lib/files/grant';
import { createItem } from '@/lib/items/mutations';
import { deriveTitle, isVideo } from '@/lib/items/bulk-upload';
import { receiptFor } from '@/lib/items/receipt';
import { clientKey, rateLimit } from '@/lib/rate-limit';
import { getArchiveUploader } from '@/lib/upload/archive-access-server';
import { ArchiveItemBody, archiveItemValues } from '@/lib/upload/archive-item';

/**
 * One item of an archive upload (/archive-upload).
 *
 * Who: the database decides (can_archive_upload(), 0043) — a content expert or
 * administrator, or a pending account inside the window an administrator
 * granted. Nothing here opens any other route to them.
 *
 * What it forces, whatever the browser sent: status `pending` and no category
 * (createItem), `uploaded_by` = the person, every file granted to this caller
 * by /api/uploads/sign, and the consent version recorded with its time.
 *
 * The AI: never called here. An item with a .txt (`skipAi`) gets no
 * ai_analyses row at all — its description is the text. Without one, images
 * and PDFs are `queued` for the quiet-hours cron (0041) and videos get none.
 */
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const { t, language } = await getMessages();
  try {
    const uploader = await getArchiveUploader();
    if (!uploader) return fail(403, 'forbidden', t('archive.noAccess'));

    const limit = rateLimit(`archive-upload:${uploader.profile.id}:${clientKey(request)}`, { limit: 200, windowMs: 10 * 60_000 });
    if (!limit.allowed) return fail(429, 'rate_limited', t('err.tooManySubmissions', { seconds: limit.retryAfterSeconds }));

    const parsed = ArchiveItemBody.safeParse(await readJson(request));
    if (!parsed.success) return invalid(parsed.error);
    const body = parsed.data;
    if (body.files.some((file) => !verifyGrant(file.path, file.expiresAt, file.grant))) {
      return fail(403, 'forbidden', t('err.oneUploadNotOurs'));
    }

    const values = archiveItemValues(body);
    const window = uploader.access === 'window';
    const item = await createItem({
      uploadedBy: uploader.profile.id,
      contributorLanguage: language.code,
      title: deriveTitle({ fileNames: [body.name] }),
      source: null,
      sourceUrl: null,
      // A windowed account is a contributor the Center can write back to;
      // an expert uploading the Center's own material is not.
      contributorEmail: window ? uploader.profile.email : null,
      contributorFullName: window ? uploader.profile.full_name : null,
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
        width: null,
        height: null,
        durationMs: file.durationMs ?? null,
        previewPath: null,
        analysis: null,
        analysisError: null,
        analysisQueued: !body.skipAi && !isVideo(file.mimeType),
        noAnalysis: body.skipAi || isVideo(file.mimeType),
      })),
    });

    return ok({ id: item.id, title: item.title, receipt: receiptFor(item.id) }, { status: 201 });
  } catch (error) {
    if ((error as { code?: string } | null)?.code === '22P02') return fail(503, 'migration_required', t('bulk.err.migration'));
    return unexpected(error, '/api/items/archive-upload');
  }
}
