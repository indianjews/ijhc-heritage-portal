import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getCurrentVolunteer } from '@/lib/supabase/server';
import { getMessages } from '@/lib/i18n';
import { ok, fail, readJson } from '@/lib/api';
import { decideRecordReport } from '@/lib/items/mutations';

/**
 * An expert resolves or dismisses a private problem report (0042).
 * Guarded here (approved session), in RLS (is_volunteer, open rows only,
 * decided_by = caller) and in the render of /review/corrections.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { t } = await getMessages();
  if (!await getCurrentVolunteer()) return fail(403, 'forbidden', t('public.conflict'));
  const { id } = await params;
  const parsed = z.object({ status: z.enum(['resolved', 'dismissed']) }).safeParse(await readJson(request));
  if (!z.uuid().safeParse(id).success || !parsed.success) return fail(400, 'invalid_request', t('public.invalid'));
  try {
    const saved = await decideRecordReport(id, parsed.data.status);
    return saved ? ok({ saved: true }) : fail(409, 'conflict', t('public.conflict'));
  } catch { return fail(409, 'conflict', t('public.conflict')); }
}
