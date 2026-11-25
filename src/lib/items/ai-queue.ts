import 'server-only';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { youtubeVideoId } from '@/lib/links/youtube';
import { readInBackground } from './background-reading';
import { isVideo } from './bulk-upload';
import {
  decideQueue,
  pacificDayStart,
  queueSettings,
  readingLanguage,
  type QueueSettings,
} from './ai-queue-policy';

/**
 * The quiet-hours reading of queued analyses (bulk upload, 0041).
 *
 * The reading itself is `readInBackground`, unchanged: same provider, same
 * 70% gate, same writes — `ai_analyses` and `ai` rows in `item_fields`, never
 * `items` (rule 1). This file only decides *whether* to read, *which* row
 * next, and what context the reading gets: the expert's notes, and the fact
 * that a video or YouTube recording is on the record but is not sent.
 *
 * ── claiming a row ──────────────────────────────────────────────────────────
 *
 * A conditional update, `queued -> pending where status = 'queued'`, is the
 * lease: two overlapping runs cannot both win it. The claim stamps
 * `last_retry_at`, which `readInBackground` then requires on its completing
 * update — so a reading that loses a race writes nothing. A run that dies
 * mid-read leaves the row `pending`; two hours later the ordinary retry
 * (0035) treats it as abandoned and reads it again.
 */

type Admin = ReturnType<typeof createAdminSupabase>;

/** Live readings recently: any row created in the window that is not waiting in the queue. */
async function countRecentLive(admin: Admin, since: Date): Promise<number> {
  const { count, error } = await admin.from('ai_analyses')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', since.toISOString())
    .neq('status', 'queued');
  if (error) throw error;
  return count ?? 0;
}

/**
 * Model calls today, deliberately counted high: every non-queued row created
 * today, plus every row whose retry or queued read started today. A row that
 * was created and retried today is counted twice, which errs towards leaving
 * more for people, never less.
 */
async function countUsedToday(admin: Admin, dayStart: Date): Promise<number> {
  const [created, retried] = await Promise.all([
    admin.from('ai_analyses').select('id', { count: 'exact', head: true })
      .gte('created_at', dayStart.toISOString()).neq('status', 'queued'),
    admin.from('ai_analyses').select('id', { count: 'exact', head: true })
      .gte('last_retry_at', dayStart.toISOString()),
  ]);
  if (created.error) throw created.error;
  if (retried.error) throw retried.error;
  return (created.count ?? 0) + (retried.count ?? 0);
}

/** Queued readings on records still waiting for review. */
async function countQueued(admin: Admin): Promise<number> {
  const { count, error } = await admin.from('ai_analyses')
    .select('id, items!inner(id)', { count: 'exact', head: true })
    .eq('status', 'queued')
    .is('items.deleted_at', null)
    .in('items.status', ['pending', 'shadow_gallery']);
  if (error) throw error;
  return count ?? 0;
}

interface QueuedRow {
  id: string;
  item_id: string;
  file_id: string;
  items: { title: string; contributor_description: string | null; source_url: string | null; contributor_language: string | null };
  item_files: { storage_path: string; file_name: string; mime_type: string };
}

/** The oldest queued readings, a page at a time. */
async function nextQueued(admin: Admin, limit: number): Promise<QueuedRow[]> {
  const { data, error } = await admin.from('ai_analyses')
    .select('id, item_id, file_id, items!inner(title, contributor_description, source_url, contributor_language, status, deleted_at), item_files!inner(storage_path, file_name, mime_type)')
    .eq('status', 'queued')
    .is('items.deleted_at', null)
    .in('items.status', ['pending', 'shadow_gallery'])
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(0, Math.max(0, limit - 1));
  if (error) throw error;
  return (data ?? []) as unknown as QueuedRow[];
}

/** Takes the row for this run, or returns null if another run already did. */
async function claim(admin: Admin, id: string): Promise<{ retry_count: number; last_retry_at: string } | null> {
  const { data, error } = await admin.from('ai_analyses')
    .update({ status: 'pending', last_retry_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'queued')
    .select('retry_count, last_retry_at');
  if (error) throw error;
  return (data?.[0] as { retry_count: number; last_retry_at: string } | undefined) ?? null;
}

/** The recordings on the record that the model is told about but not sent. */
async function attachedMedia(admin: Admin, itemId: string, sourceUrl: string | null) {
  const { data, error } = await admin.from('item_files')
    .select('file_name, mime_type')
    .eq('item_id', itemId)
    .order('position', { ascending: true })
    .range(0, 99);
  if (error) throw error;
  return {
    videos: (data ?? []).filter((f) => isVideo(String(f.mime_type))).map((f) => String(f.file_name)),
    youtubeUrl: sourceUrl && youtubeVideoId(sourceUrl) ? sourceUrl : null,
  };
}

export interface QueueRunResult {
  skipped?: 'busy' | 'quota_reserve' | 'disabled';
  attempted: number;
  allowance: number;
  recentLive: number;
  usedToday: number;
  remainingPending: number;
  settings: QueueSettings;
}

/** Stop starting readings this long after the run began (route limit is 300 s). */
export const QUEUE_START_BUDGET_MS = 200_000;

export async function processQueuedReadings(options: { now?: () => number; settings?: QueueSettings } = {}): Promise<QueueRunResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const settings = options.settings ?? queueSettings();
  const admin = createAdminSupabase();

  const [recentLive, usedToday] = await Promise.all([
    countRecentLive(admin, new Date(started - settings.recentWindowMs)),
    countUsedToday(admin, pacificDayStart(new Date(started))),
  ]);
  const decision = decideQueue({ recentLive, usedToday, settings });
  const base = { recentLive, usedToday, settings };

  if (decision.action === 'skip') {
    return { ...base, skipped: decision.reason, attempted: 0, allowance: 0, remainingPending: await countQueued(admin) };
  }

  let attempted = 0;
  // A few extra rows, in case some are claimed by an overlapping run.
  for (const row of await nextQueued(admin, decision.allowance + 5)) {
    if (attempted >= decision.allowance || now() - started > QUEUE_START_BUDGET_MS) break;

    if (isVideo(row.item_files.mime_type)) {
      // Never queued by the bulk route; refused here too, so video bytes never reach the model.
      await admin.from('ai_analyses')
        .update({ status: 'failed', error: 'Video files are not read by the model.' })
        .eq('id', row.id).eq('status', 'queued');
      continue;
    }

    const lease = await claim(admin, row.id);
    if (!lease) continue;
    attempted += 1;

    await readInBackground({
      itemId: row.item_id,
      title: row.items.title,
      known: row.items.contributor_description ?? undefined,
      language: readingLanguage(row.items.contributor_language),
      attachedMedia: await attachedMedia(admin, row.item_id, row.items.source_url),
      files: [{
        fileId: row.file_id,
        storagePath: row.item_files.storage_path,
        fileName: row.item_files.file_name,
        analysisId: row.id,
        retryCount: lease.retry_count,
        lastRetryAt: lease.last_retry_at,
      }],
    }, started);
  }

  return { ...base, attempted, allowance: decision.allowance, remainingPending: await countQueued(admin) };
}
