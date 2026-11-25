import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * The nightly backup's choice of destination, and the Drive run end to end
 * against a fake database and a fake bridge. No network, no Supabase.
 */

const mocks = vi.hoisted(() => ({
  problem: vi.fn<(row: { message: string }) => Promise<void>>(async () => {}),
  rows: {} as Record<string, unknown[]>,
  short: new Set<string>(),
  ranges: [] as [string, number, number][],
}));

vi.mock('@/lib/problems/record', () => ({ recordProblem: mocks.problem }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: () => ({
    from: (table: string) => ({
      select: (_columns: string, options?: { count?: string; head?: boolean }) => {
        const all = mocks.rows[table] ?? [];
        if (options?.head) return Promise.resolve({ count: all.length + (mocks.short.has(table) ? 1 : 0), error: null });
        const query = {
          order: () => query,
          range: async (from: number, to: number) => {
            mocks.ranges.push([table, from, to]);
            return { data: all.slice(from, to + 1), error: null };
          },
        };
        return query;
      },
    }),
    storage: { from: () => ({ download: async () => ({ data: null, error: new Error('no storage in tests') }) }) },
  }),
}));

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
  mocks.rows = { items: Array.from({ length: 2500 }, (_, i) => ({ id: i })), profiles: [{ id: 'p' }] };
  mocks.short.clear();
  mocks.ranges = [];
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
    expect(mocks.ranges.filter(([t]) => t === 'items')).toEqual([['items', 0, 999], ['items', 1000, 1999], ['items', 2000, 2999]]);
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
    mocks.short.add('profiles');
    stubBridge();
    const body = await data(await GET(request()));
    expect(body.database.short).toEqual(['profiles']);
    expect(body.manifest).toBe(false);
    expect(mocks.problem).toHaveBeenCalled();
  });
});
