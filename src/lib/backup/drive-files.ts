import 'server-only';
import type { createAdminSupabase } from '@/lib/supabase/admin';
import { BudgetExceeded, type BridgeClient } from './gdrive-bridge';

/**
 * The file bytes, to Google Drive, a few at a time.
 *
 * ── where they go ───────────────────────────────────────────────────────────
 *
 * Under a permanent `files/` folder, mirroring the bucket:
 *
 *   uploads/2026/08/<uuid>-scan.jpg  →  dir  files/uploads/2026/08
 *                                       name <uuid>-scan.jpg
 *
 * Never inside a dated run folder: those are pruned after fourteen runs, and a
 * scan is copied once, ever. `files` is not named like a run, so retention
 * cannot select it (`foldersToTrash`) and the bridge client refuses to trash it
 * even if asked (`trashFolder`). Mirroring rather than flattening with `__`
 * (as `scripts/backup.ts` does on disk) keeps the restore rule trivial —
 * `files/` + `storage_path` — and is reversible for any key, including one
 * that itself contains `__`.
 *
 * ── what "copied" means ─────────────────────────────────────────────────────
 *
 * `item_files.backed_up_at` (migration 0040) is set only after the bridge
 * answered `ok: true` for that file. A failed or timed-out upload leaves it
 * NULL, so the file is simply tried again on a later night. Only masters are
 * copied: `preview_path` renditions are derived from them and can be rebuilt.
 *
 * ── why the limits ──────────────────────────────────────────────────────────
 *
 * An Apps Script Web App accepts a request body of roughly 50 MB, and base64
 * makes a file a third larger, inside a JSON body. 25 MB leaves room. Larger
 * files are never downloaded here: they are reported, and need another route
 * (`scripts/backup.ts`, or the S3 destination).
 */

/** Largest file sent through the bridge: 25 MB of bytes is ~33 MB of base64. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** At most this many files per run, whatever the budget. */
export const FILE_BATCH = 20;

/** No new file is started with less than this left of the run's budget. */
export const FILE_RESERVE_MS = 8_000;

/** A file this large needs extra room on top of the reserve. */
export const LARGE_FILE_BYTES = 8_000_000;
export const LARGE_FILE_EXTRA_MS = 12_000;

/** How many oversize files to name in the response; the count covers all of them. */
const OVERSIZE_LISTED = 50;

/** Where a storage key lands on Drive. Pure. */
export function driveLocation(storagePath: string): { dir: string; fileName: string } {
  const parts = storagePath.split('/').filter(Boolean);
  const fileName = parts.pop() ?? '';
  return { dir: ['files', ...parts].join('/'), fileName };
}

/** Whether there is time to start a file of this size. Pure. */
export function canStartFile(now: number, deadline: number, bytes: number): boolean {
  const needed = FILE_RESERVE_MS + (bytes > LARGE_FILE_BYTES ? LARGE_FILE_EXTRA_MS : 0);
  return deadline - now >= needed;
}

type Admin = ReturnType<typeof createAdminSupabase>;

interface PendingFile {
  id: string;
  storage_path: string;
  mime_type: string | null;
  byte_size: number;
}

export interface FilePhaseResult {
  filePhase: 'done' | 'budget' | 'unavailable';
  filesBackedUp: number;
  filesFailed: { path: string; error: string }[];
  filesSkippedOversize: { path: string; bytes: number }[];
  /** All files with no off-site copy yet, oversize ones included. Null when it could not be counted. */
  filesRemaining: number | null;
}

/** Postgres "undefined column": migration 0040 has not been applied. */
function missingColumn(error: { code?: string; message?: string } | null): boolean {
  return Boolean(error && (error.code === '42703' || /backed_up_at/.test(error.message ?? '')));
}

export async function backupFilesToDrive(options: {
  admin: Admin;
  client: BridgeClient;
  deadline: number;
  /** Records one problem; the caller redacts. Returns the logged text. */
  report: (message: string) => Promise<string>;
  now?: () => number;
}): Promise<FilePhaseResult> {
  const { admin, client, deadline, report } = options;
  const now = options.now ?? Date.now;
  const result: FilePhaseResult = {
    filePhase: 'done', filesBackedUp: 0, filesFailed: [], filesSkippedOversize: [], filesRemaining: null,
  };

  // ── what is waiting, small enough to send ──────────────────────────────────
  const { data: pending, error: pendingError } = await admin
    .from('item_files')
    .select('id, storage_path, mime_type, byte_size')
    .is('backed_up_at', null)
    .lte('byte_size', MAX_FILE_BYTES)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(0, FILE_BATCH - 1);

  if (pendingError) {
    result.filePhase = 'unavailable';
    await report(missingColumn(pendingError)
      ? 'File backup skipped: item_files.backed_up_at does not exist. Apply migration 0040.'
      : `File backup skipped: could not list pending files (${pendingError.message})`);
    return result;
  }

  // ── what is waiting, too large for the bridge ──────────────────────────────
  // Queried apart, so a large file at the head of the queue never blocks the
  // small ones behind it night after night.
  const { data: oversize, error: oversizeError } = await admin
    .from('item_files')
    .select('storage_path, byte_size')
    .is('backed_up_at', null)
    .gt('byte_size', MAX_FILE_BYTES)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(0, OVERSIZE_LISTED - 1);
  if (!oversizeError) {
    result.filesSkippedOversize = (oversize ?? []).map((f) => ({ path: f.storage_path as string, bytes: Number(f.byte_size) }));
  }

  // ── one file at a time, inside the budget ──────────────────────────────────
  for (const file of (pending ?? []) as PendingFile[]) {
    if (!canStartFile(now(), deadline, Number(file.byte_size))) {
      result.filePhase = 'budget';
      break;
    }
    const path = file.storage_path;
    try {
      const { data: blob, error: downloadError } = await admin.storage.from('heritage').download(path);
      if (downloadError || !blob) throw new Error(`could not download (${downloadError?.message ?? 'no body'})`);
      const bytes = Buffer.from(await blob.arrayBuffer());
      // The column is measured at upload, but the bytes are what gets sent.
      if (bytes.byteLength > MAX_FILE_BYTES) {
        result.filesSkippedOversize.push({ path, bytes: bytes.byteLength });
        continue;
      }

      const { dir, fileName } = driveLocation(path);
      await client.upload({
        dir,
        fileName,
        mimeType: file.mime_type || 'application/octet-stream',
        encoding: 'base64',
        content: bytes.toString('base64'),
      });

      const { error: markError } = await admin
        .from('item_files')
        .update({ backed_up_at: new Date(now()).toISOString() })
        .eq('id', file.id);
      if (markError) {
        // On Drive but not marked: it will be sent again; say so rather than count it as done.
        throw new Error(`uploaded but not marked as backed up (${markError.message})`);
      }
      result.filesBackedUp += 1;
    } catch (error) {
      if (error instanceof BudgetExceeded) {
        result.filePhase = 'budget';
        break;
      }
      // BridgeError text is already redacted by the client; `report` redacts again regardless.
      const reason = error instanceof Error ? error.message : 'unexpected failure';
      result.filesFailed.push({ path, error: await report(`File backup failed: ${path}: ${reason}`) });
    }
  }

  if (result.filesSkippedOversize.length) {
    // One problem per run, not one per file: the alert mail is deduplicated by text.
    const listed = result.filesSkippedOversize.slice(0, 5).map((f) => `${f.path} (${(f.bytes / 1e6).toFixed(1)} MB)`).join(', ');
    await report(
      `File backup: ${result.filesSkippedOversize.length} file(s) over ${MAX_FILE_BYTES / 1024 / 1024} MB cannot go through the Drive bridge and need another backup route: ${listed}`,
    );
  }

  // ── what is still without an off-site copy ─────────────────────────────────
  const { count, error: countError } = await admin
    .from('item_files')
    .select('id', { count: 'exact', head: true })
    .is('backed_up_at', null);
  result.filesRemaining = countError ? null : (count ?? 0);
  return result;
}
