import { getCurrentVolunteer } from '@/lib/supabase/server';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { fail, invalid, ok, readJson, unexpected } from '@/lib/api';
import { verifyGrant } from '@/lib/files/grant';
import { createRecordingItem } from '@/lib/items/mutations';
import { receiptFor } from '@/lib/items/receipt';
import { COMMUNITIES } from '@/lib/types';
import { youtubeVideoId } from '@/lib/links/youtube';
import { getMessages } from '@/lib/i18n';

const FileBody = z.object({
  path: z.string().min(1),
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1),
  byteSize: z.number().int().positive(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
  expiresAt: z.number(),
  grant: z.string().min(1),
});

const Body = z.object({
  title: z.string().trim().min(1).max(200),
  sourceUrl: z.string().trim().min(1).max(2000),
  community: z.enum(COMMUNITIES as [string, ...string[]]).nullable().optional(),
  consentVersion: z.string().trim().min(1).max(40),
  files: z.array(FileBody).max(10).optional().default([]),
});

export async function POST(request: NextRequest) {
  const { t } = await getMessages();

  try {
    const volunteer = await getCurrentVolunteer();
    if (!volunteer) return fail(401, 'unauthorized', t('review3.signIn'));

    const parsed = Body.safeParse(await readJson(request));
    if (!parsed.success) return invalid(parsed.error);

    const body = parsed.data;

    // Validate that the URL is actually a YouTube link.
    if (!youtubeVideoId(body.sourceUrl)) {
      return fail(400, 'invalid_url', t('upload.recording.urlInvalid'));
    }

    // Every file must carry a valid grant token proving it was uploaded by this caller.
    const ungranted = body.files.find((file) => !verifyGrant(file.path, file.expiresAt, file.grant));
    if (ungranted) return fail(403, 'forbidden', t('err.oneUploadNotOurs'));

    const item = await createRecordingItem({
      uploadedBy: volunteer.id,
      title: body.title,
      sourceUrl: body.sourceUrl,
      community: (body.community as import('@/lib/types').Community | null | undefined) ?? null,
      consentVersion: body.consentVersion,
      files: body.files.map((file) => ({
        storagePath: file.path,
        fileName: file.fileName,
        mimeType: file.mimeType,
        byteSize: file.byteSize,
        width: file.width ?? null,
        height: file.height ?? null,
        durationMs: null,
        previewPath: null,
        analysis: null,
        analysisError: null,
      })),
    });

    return ok({ id: item.id, token: receiptFor(item.id) });
  } catch (err) {
    return unexpected(err, 'POST /api/items/recording');
  }
}
