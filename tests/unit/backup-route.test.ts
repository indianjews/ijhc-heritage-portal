import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { fakeState } from './helpers/fake-admin';

/**
 * The nightly backup's choice of destination, and the Drive run end to end
 * against a fake database and a fake bridge. No network, no Supabase.
 */

const mocks = vi.hoisted(() => ({
  problem: vi.fn<(row: { message: string }) => Promise<void>>(async () => {}),
  state: null as unknown as import('./helpers/fake-admin').FakeAdminState,
}));

vi.mock('@/lib/problems/record', () => ({ recordProblem: mocks.problem }));
vi.mock('@/lib/supabase/admin', async () => {
  const { fakeAdmin } = await import('./helpers/fake-admin');
  return { createAdminSupabase: () => fakeAdmin(mocks.state) };
});

const { GET } = await import('@/app/api/cron/backup/route');

const SECRET = 'x'.repeat(40);
const DEPLOYMENT = 'AKfycbTEST_deployment';
const WEBHOOK = `https://script.google.com/macros/s/${DEPLOYMENT}/exec`;
const ENV_KEYS = ['CRON_SECRET', 'CRON_HOME', 'BACKUP_GDRIVE_WEBHOOK_URL', 'BACKUP_GDRIVE_SECRET',
  'BACKUP_S3_ENDPOINT', 'BACKUP_S3_BUCKET', 'BACKUP_S3_ACCESS_KEY_ID', 'BACKUP_S3_SECRET_ACCESS_KEY'];

/** `ok()` answers `{ ok: true, data }`. */
async function data(response: Response) {
  return (await response.json()).data;
}

function request(token = 'cron-secret') {
  return new NextRequest('https://archive.example/api/cron/backup', { headers: { authorization: `Bearer ${token}` } });
}

let saved: Record<string, string | undefined>;
let sent: Record<string, unknown>[];

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.CRON_SECRET = 'cron-secret';
  process.env.CRON_HOME = '1';
  mocks.state = fakeState();
  mocks.state.rows = { items: Array.from({ length: 2500 }, (_, i) => ({ id: i })), profiles: [{ id: 'p' }] };
  mocks.problem.mockClear();
  sent = [];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

function stubBridge(answer: (body: Record<string, unknown>) => unknown = (body) =>
  body.action === 'list_folders' ? { ok: true, folders: [] } : body.action === 'trash_folder' ? { ok: true, trashed: 1 } : { ok: true, id: 'f', name: String(body.fileName) }) {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    sent.push(body);
    return new Response(JSON.stringify(answer(body)), { headers: { 'content-type': 'application/json' } });
  }));
}

describe('/api/cron/backup guards', () => {
  it('still requires the cron secret', async () => {
    expect((await GET(request('wrong'))).status).toBe(401);
  });

  it('still skips outside the cron home', async () => {
    process.env.CRON_HOME = '0';
    expect(await data(await GET(request()))).toMatchObject({ skipped: 'not the cron home' });
  });
});

describe('/api/cron/backup destination', () => {
  it('answers "not configured" when neither destination is set', async () => {
    const body = await data(await GET(request()));
    expect(body).toMatchObject({ configured: false });
    expect(body.note).toContain('BACKUP_GDRIVE_WEBHOOK_URL');
  });

  it('refuses a half-configured Drive bridge, loudly and without the secret', async () => {
    process.env.BACKUP_GDRIVE_SECRET = SECRET;
    const response = await GET(request());
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain('BACKUP_GDRIVE_WEBHOOK_URL');
    expect(text).not.toContain(SECRET);
    expect(mocks.problem).toHaveBeenCalledOnce();
  });

  it('uses Drive when configured: every table, then the manifest, then pruning', async () => {
    process.env.BACKUP_GDRIVE_WEBHOOK_URL = WEBHOOK;
    process.env.BACKUP_GDRIVE_SECRET = SECRET;
    stubBridge();
    const body = await data(await GET(request()));

    expect(body).toMatchObject({ configured: true, destination: 'gdrive', manifest: true, stopped: 'finished' });
    expect(body.database.counts.items).toBe(2500);
    expect(body.database.failed).toEqual([]);

    const uploads = sent.filter((b) => b.action === 'upload');
    expect(uploads.at(-1)).toMatchObject({ fileName: 'manifest.json' });
    const items = uploads.find((b) => b.fileName === 'items.json')!;
    expect(items.dir).toMatch(/^\d{4}-\d{2}-\d{2}\/tables$/);
    expect(JSON.parse(items.content as string)).toHaveLength(2500);
    expect(sent.at(-1)).toMatchObject({ action: 'list_folders' });
    expect(sent.every((b) => b.secret === SECRET)).toBe(true);

    // 2500 rows were read in 1000-row pages, not one capped select.
    expect(mocks.state.ranges.filter(([t]) => t === 'items')).toEqual([['items', 0, 999], ['items', 1000, 1999], ['items', 2000, 2999]]);
  });

  it('prefers Drive over S3 when both are configured', async () => {
    process.env.BACKUP_GDRIVE_WEBHOOK_URL = WEBHOOK;
    process.env.BACKUP_GDRIVE_SECRET = SECRET;
    Object.assign(process.env, { BACKUP_S3_ENDPOINT: 'https://s3.example', BACKUP_S3_BUCKET: 'b', BACKUP_S3_ACCESS_KEY_ID: 'k', BACKUP_S3_SECRET_ACCESS_KEY: 's' });
    stubBridge();
    expect((await data(await GET(request()))).destination).toBe('gdrive');
  });

  it('keeps going past a failed table, withholds the manifest and does not prune', async () => {
    process.env.BACKUP_GDRIVE_WEBHOOK_URL = WEBHOOK;
    process.env.BACKUP_GDRIVE_SECRET = SECRET;
    stubBridge((body) => body.fileName === 'items.json'
      ? { ok: false, error: `quota exceeded for ${SECRET}` }
      : { ok: true, id: 'f', name: String(body.fileName) });
    const body = await data(await GET(request()));

    expect(body.manifest).toBe(false);
    expect(body.pruned).toEqual([]);
    expect(body.database.failed).toHaveLength(1);
    expect(body.database.failed[0].table).toBe('items');
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(sent.some((b) => b.fileName === 'manifest.json')).toBe(false);
    expect(sent.some((b) => b.action === 'list_folders' || b.action === 'trash_folder')).toBe(false);
    // Uploads after the failed one still happened.
    expect(sent.some((b) => b.fileName === 'item_files.json')).toBe(true);
    for (const [row] of mocks.problem.mock.calls) expect(row.message).not.toContain(SECRET);
  });

  it('withholds the manifest when a table read short of its live count', async () => {
    process.env.BACKUP_GDRIVE_WEBHOOK_URL = WEBHOOK;
    process.env.BACKUP_GDRIVE_SECRET = SECRET;
    mocks.state.short.add('profiles');
    stubBridge();
    const body = await data(await GET(request()));
    expect(body.database.short).toEqual(['profiles']);
    expect(body.manifest).toBe(false);
    expect(mocks.problem).toHaveBeenCalled();
  });
});

describe('/api/cron/backup incremental files (Drive)', () => {
  const MB = 1024 * 1024;
  const file = (id: string, path: string, created: string, bytes = 3) =>
    ({ id, storage_path: path, mime_type: 'image/jpeg', byte_size: bytes, created_at: created, backed_up_at: null });

  beforeEach(() => {
    process.env.BACKUP_GDRIVE_WEBHOOK_URL = WEBHOOK;
    process.env.BACKUP_GDRIVE_SECRET = SECRET;
  });

  it('copies files under files/, marks only successes, and reports the counts', async () => {
    mocks.state.rows.item_files = [
      file('b', 'uploads/2026/08/b-second.jpg', '2026-08-02'),
      file('a', 'uploads/2026/08/a-first.jpg', '2026-08-01'),
      file('big', 'uploads/2026/08/big.tif', '2026-08-03', 30 * MB),
    ];
    mocks.state.storage = {
      'uploads/2026/08/a-first.jpg': new Uint8Array([1, 2, 3]),
      'uploads/2026/08/b-second.jpg': new Uint8Array([4, 5, 6]),
    };
    stubBridge((body) => body.fileName === 'b-second.jpg'
      ? { ok: false, error: `drive full ${SECRET}` }
      : body.action === 'list_folders' ? { ok: true, folders: [{ id: 'f', name: 'files' }] }
      : { ok: true, id: 'x', name: String(body.fileName) });

    const body = await data(await GET(request()));

    const fileUploads = sent.filter((b) => b.action === 'upload' && b.encoding === 'base64');
    expect(fileUploads.map((b) => [b.dir, b.fileName])).toEqual([
      ['files/uploads/2026/08', 'a-first.jpg'],
      ['files/uploads/2026/08', 'b-second.jpg'],
    ]);
    expect(fileUploads[0].content).toBe(Buffer.from([1, 2, 3]).toString('base64'));
    expect(fileUploads.every((b) => !/^\d{4}-\d{2}-\d{2}/.test(String(b.dir)))).toBe(true);

    expect(mocks.state.updates.map((u) => u.id)).toEqual(['a']);
    expect(body).toMatchObject({ filePhase: 'done', filesBackedUp: 1, filesRemaining: 2 });
    expect(body.filesFailed).toHaveLength(1);
    expect(body.filesSkippedOversize).toEqual([{ path: 'uploads/2026/08/big.tif', bytes: 30 * MB }]);
    expect(JSON.stringify(body)).not.toContain(SECRET);
    // The permanent files/ folder is never offered for trashing.
    expect(sent.some((b) => b.action === 'trash_folder')).toBe(false);
    // Tables still backed up and the manifest still written.
    expect(body.manifest).toBe(true);
  });

  it('keeps the table backup when migration 0040 is not applied', async () => {
    mocks.state.rows.item_files = [file('a', 'uploads/a.jpg', '2026-08-01')];
    mocks.state.columnMissing = true;
    stubBridge();
    const body = await data(await GET(request()));
    expect(body.manifest).toBe(true);
    expect(body.filePhase).toBe('unavailable');
    expect(mocks.problem.mock.calls.some(([row]) => row.message.includes('migration 0040'))).toBe(true);
  });
});

