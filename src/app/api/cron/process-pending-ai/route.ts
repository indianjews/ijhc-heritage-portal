import { isCronHome } from '@/lib/cron-home';
import { timingSafeEqual } from 'node:crypto';
import { fail, ok, unexpected } from '@/lib/api';
import { processQueuedReadings } from '@/lib/items/ai-queue';
import { getMessages } from '@/lib/i18n';

/**
 * The quiet-hours reading of queued analyses (bulk upload, 0041).
 *
 * Scheduled in vercel.json for 23:30 UTC — 05:00 in India, 01:30/02:30 in
 * Israel — and guarded twice more inside: it skips when people are using the
 * archive (`busy`) or when today's allowance is down to the reserve kept for
 * them (`quota_reserve`). See src/lib/items/ai-queue-policy.ts.
 */
export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const offered = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  if (!secret || offered.length !== expected.length || !timingSafeEqual(offered, expected)) {
    const { t } = await getMessages();
    return fail(401, 'unauthenticated', t('phase2.forbidden'));
  }
  if (!isCronHome()) return ok({ skipped: 'not the cron home' });
  try {
    const result = await processQueuedReadings();
    return ok(result);
  } catch (error) {
    return unexpected(error, '/api/cron/process-pending-ai');
  }
}
