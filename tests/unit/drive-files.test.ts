import { describe, expect, it, vi } from 'vitest';
import {
  FILE_BATCH,
  FILE_RESERVE_MS,
  LARGE_FILE_BYTES,
  LARGE_FILE_EXTRA_MS,
  MAX_FILE_BYTES,
  backupFilesToDrive,
  canStartFile,
  driveLocation,
} from '@/lib/backup/drive-files';
import { BridgeError, BudgetExceeded, createBridgeClient, foldersToTrash, redact, type BridgeClient } from '@/lib/backup/gdrive-bridge';
import { fakeAdmin, fakeState } from './helpers/fake-admin';

/**
 * The incremental file phase of the Drive backup, against an in-memory
 * database and a fake bridge client. No network, no Supabase.
 */

const MB = 1024 * 1024;

function file(id: string, created: string, bytes = 3, path = `uploads/2026/08/${id}.jpg`) {
  return { id, storage_path: path, mime_type: 'image/jpeg', byte_size: bytes, created_at: created, backed_up_at: null as string | null };
}

function setup(files: ReturnType<typeof file>[], options: { withBytes?: boolean } = {}) {
  const state = fakeState();
  state.rows.item_files = files;
  if (options.withBytes !== false) {
    for (const f of files) state.storage[f.storage_path] = new Uint8Array(Math.min(f.byte_size, 16)).fill(7);
  }
  const uploads: Parameters<BridgeClient['upload']>[0][] = [];
  const client: BridgeClient = {
    upload: vi.fn(async (input) => { uploads.push(input); return { id: 'x', name: input.fileName }; }),
    listFolders: vi.fn(async () => []),
    trashFolder: vi.fn(async () => 0),
    prune: vi.fn(async () => []),
  };
  const report = vi.fn(async (message: string) => message);
  return { state, admin: fakeAdmin(state) as never, client, uploads, report };
}

describe('pure rules', () => {
  it('mirrors the storage path under files/, with no slash in the file name', () => {
    expect(driveLocation('uploads/2026/08/abc-scan.jpg')).toEqual({ dir: 'files/uploads/2026/08', fileName: 'abc-scan.jpg' });
    expect(driveLocation('loose.pdf')).toEqual({ dir: 'files', fileName: 'loose.pdf' });
    expect(driveLocation('a__b/c__d.jpg')).toEqual({ dir: 'files/a__b', fileName: 'c__d.jpg' });
  });

  it('files/ is never a retention candidate', () => {
    const folders = ['files', '2026-11-01', '2026-11-02'].map((name) => ({ id: name, name }));
    expect(foldersToTrash(folders, 1, '2026-11-02')).toEqual(['2026-11-01']);
  });

  it('does not start a file inside the last eight seconds, or a large one inside twenty', () => {
    expect(canStartFile(0, FILE_RESERVE_MS, 10)).toBe(true);
    expect(canStartFile(1, FILE_RESERVE_MS, 10)).toBe(false);
    expect(canStartFile(0, FILE_RESERVE_MS + LARGE_FILE_EXTRA_MS - 1, LARGE_FILE_BYTES + 1)).toBe(false);
    expect(canStartFile(0, FILE_RESERVE_MS + LARGE_FILE_EXTRA_MS, LARGE_FILE_BYTES + 1)).toBe(true);
  });

  it('keeps the size limit well under the Apps Script body limit after base64', () => {
    expect(Math.ceil(MAX_FILE_BYTES / 3) * 4).toBeLessThan(40 * MB);
  });
});

describe('backupFilesToDrive', () => {
  it('uploads oldest first as base64 and marks each file only after the bridge said ok', async () => {
    const { state, admin, client, uploads, report } = setup([file('b', '2026-08-02'), file('a', '2026-08-01')]);
    const result = await backupFilesToDrive({ admin, client, deadline: Date.now() + 60_000, report });

    expect(uploads.map((u) => u.fileName)).toEqual(['a.jpg', 'b.jpg']);
    expect(uploads[0]).toMatchObject({ dir: 'files/uploads/2026/08', encoding: 'base64', mimeType: 'image/jpeg' });
    expect(Buffer.from(uploads[0].content, 'base64')).toEqual(Buffer.alloc(3, 7));
    expect(state.updates.map((u) => u.id)).toEqual(['a', 'b']);
    expect(typeof state.updates[0].values.backed_up_at).toBe('string');
    expect(result).toEqual({ filePhase: 'done', filesBackedUp: 2, filesFailed: [], filesSkippedOversize: [], filesRemaining: 0 });
    expect(report).not.toHaveBeenCalled();
  });

  it('takes at most one batch per run, and pages with range()', async () => {
    const files = Array.from({ length: FILE_BATCH + 5 }, (_, i) => file(`f${String(i).padStart(2, '0')}`, `2026-08-${String(i + 1).padStart(2, '0')}`));
    const { state, admin, client, report } = setup(files);
    const result = await backupFilesToDrive({ admin, client, deadline: Date.now() + 60_000, report });
    expect(result.filesBackedUp).toBe(FILE_BATCH);
    expect(result.filesRemaining).toBe(5);
    expect(state.ranges[0]).toEqual(['item_files', 0, FILE_BATCH - 1]);
  });

  it('does not mark a file whose upload failed, and carries on with the next', async () => {
    const { state, admin, client, report } = setup([file('a', '2026-08-01'), file('b', '2026-08-02')]);
    vi.mocked(client.upload).mockImplementationOnce(async () => { throw new BridgeError('bridge upload: drive full', 'upload'); });
    const result = await backupFilesToDrive({ admin, client, deadline: Date.now() + 60_000, report });
    expect(state.updates.map((u) => u.id)).toEqual(['b']);
    expect(result.filesBackedUp).toBe(1);
    expect(result.filesFailed).toEqual([{ path: 'uploads/2026/08/a.jpg', error: 'File backup failed: uploads/2026/08/a.jpg: bridge upload: drive full' }]);
    expect(result.filesRemaining).toBe(1);
  });

  it('counts a missing object as a failure, not a crash', async () => {
    const { admin, client, report } = setup([file('a', '2026-08-01')], { withBytes: false });
    const result = await backupFilesToDrive({ admin, client, deadline: Date.now() + 60_000, report });
    expect(result.filesFailed[0].error).toContain('could not download');
    expect(client.upload).not.toHaveBeenCalled();
  });

  it('reports a file that reached Drive but could not be marked as failed', async () => {
    const { state, admin, client, report } = setup([file('a', '2026-08-01')]);
    state.failUpdateFor!.add('a');
    const result = await backupFilesToDrive({ admin, client, deadline: Date.now() + 60_000, report });
    expect(result.filesBackedUp).toBe(0);
    expect(result.filesFailed[0].error).toContain('uploaded but not marked');
  });

  it('stops starting files when the budget runs low, and leaves the rest unmarked', async () => {
    let clock = 0;
    const { state, admin, client, report } = setup([file('a', '2026-08-01'), file('b', '2026-08-02'), file('c', '2026-08-03')]);
    state.onDownload = () => { clock += 5_000; };
    const result = await backupFilesToDrive({ admin, client, deadline: 20_000, report, now: () => clock });
    // Each download costs 5s: a starts with 20s left, b with 15s, c with 10s — all above the 8s reserve.
    expect(result.filesBackedUp).toBe(3);

    clock = 0;
    const second = setup([file('d', '2026-08-01'), file('e', '2026-08-02')]);
    second.state.onDownload = () => { clock += 7_000; };
    const stopped = await backupFilesToDrive({ admin: second.admin, client: second.client, deadline: 14_000, report: second.report, now: () => clock });
    // d starts with 14s left and takes 7s; e would start with 7s left, under the 8s reserve.
    expect(stopped.filePhase).toBe('budget');
    expect(stopped.filesBackedUp).toBe(1);
    expect(second.state.updates.map((u) => u.id)).toEqual(['d']);
    expect(stopped.filesRemaining).toBe(1);
  });

  it('stops cleanly when the client itself runs out of budget', async () => {
    const { state, admin, client, report } = setup([file('a', '2026-08-01'), file('b', '2026-08-02')]);
    vi.mocked(client.upload).mockImplementation(async () => { throw new BudgetExceeded(); });
    const result = await backupFilesToDrive({ admin, client, deadline: Date.now() + 60_000, report });
    expect(result.filePhase).toBe('budget');
    expect(result.filesFailed).toEqual([]);
    expect(state.updates).toEqual([]);
    expect(report).not.toHaveBeenCalled();
  });

  it('skips oversize files without downloading them, keeps going, and reports them once', async () => {
    const big = file('big', '2026-08-01', MAX_FILE_BYTES + 1, 'uploads/2026/08/big.tif');
    const bigger = file('bigger', '2026-08-02', 60 * MB, 'uploads/2026/08/bigger.mov');
    const { state, admin, client, report } = setup([big, bigger, file('small', '2026-08-03')], { withBytes: false });
    state.storage['uploads/2026/08/small.jpg'] = new Uint8Array([1]);
    const downloads: string[] = [];
    state.onDownload = (path) => downloads.push(path);

    const result = await backupFilesToDrive({ admin, client, deadline: Date.now() + 60_000, report });
    expect(downloads).toEqual(['uploads/2026/08/small.jpg']);
    expect(result.filesBackedUp).toBe(1);
    expect(result.filesSkippedOversize).toEqual([
      { path: 'uploads/2026/08/big.tif', bytes: MAX_FILE_BYTES + 1 },
      { path: 'uploads/2026/08/bigger.mov', bytes: 60 * MB },
    ]);
    expect(result.filesRemaining).toBe(2);
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0][0]).toMatch(/2 file\(s\) over 25 MB/);
  });

  it('catches a file whose bytes are larger than its recorded size', async () => {
    const { state, admin, client, report } = setup([file('liar', '2026-08-01', 10)], { withBytes: false });
    state.storage['uploads/2026/08/liar.jpg'] = new Uint8Array(MAX_FILE_BYTES + 1);
    const result = await backupFilesToDrive({ admin, client, deadline: Date.now() + 60_000, report });
    expect(client.upload).not.toHaveBeenCalled();
    expect(result.filesSkippedOversize).toEqual([{ path: 'uploads/2026/08/liar.jpg', bytes: MAX_FILE_BYTES + 1 }]);
    expect(state.updates).toEqual([]);
  });

  it('says plainly when migration 0040 is missing', async () => {
    const { state, admin, client, report } = setup([file('a', '2026-08-01')]);
    state.columnMissing = true;
    const result = await backupFilesToDrive({ admin, client, deadline: Date.now() + 60_000, report });
    expect(result).toMatchObject({ filePhase: 'unavailable', filesBackedUp: 0, filesRemaining: null });
    expect(report.mock.calls[0][0]).toContain('Apply migration 0040');
    expect(client.upload).not.toHaveBeenCalled();
  });

  it('never lets the secret or deployment id reach a failure message (real client, fake fetch)', async () => {
    const secret = 's'.repeat(40);
    const config = { url: 'https://script.google.com/macros/s/AKfycbSECRETDEPLOY/exec', secret };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: `bad ${secret} AKfycbSECRETDEPLOY` }), {
      headers: { 'content-type': 'application/json' },
    }));
    const client = createBridgeClient(config, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const { state, admin } = setup([file('a', '2026-08-01')]);
    const report = vi.fn(async (message: string) => redact(message, config));

    const result = await backupFilesToDrive({ admin, client, deadline: Date.now() + 60_000, report });
    const text = JSON.stringify(result) + JSON.stringify(report.mock.calls);
    expect(text).not.toContain(secret);
    expect(text).not.toContain('AKfycbSECRETDEPLOY');
    expect(state.updates).toEqual([]);
    // The secret was sent, in the body, where the bridge needs it.
    expect(JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).secret).toBe(secret);
  });
});
