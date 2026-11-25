import { describe, expect, it, vi } from 'vitest';
import {
  BridgeError,
  BudgetExceeded,
  KEEP_RUNS,
  bridgeConfig,
  buildPayload,
  createBridgeClient,
  foldersToTrash,
  parseResponse,
  redact,
  validDir,
  validFileName,
  type BridgeConfig,
} from '@/lib/backup/gdrive-bridge';

/**
 * The Google Drive bridge, with no network.
 *
 * The secret travels in the request body (Apps Script strips headers), so
 * the tests that matter most are the ones about where the body may go and
 * what an error is allowed to say.
 */

const SECRET = 'a'.repeat(24) + 'S3CR3T-value-0123456789';
const DEPLOYMENT = 'AKfycbx_DEPLOYMENT-id_123';
const URL_OK = `https://script.google.com/macros/s/${DEPLOYMENT}/exec`;
const CONFIG: BridgeConfig = { url: URL_OK, secret: SECRET };

function json(body: unknown, status = 200, type = 'application/json') {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
}

describe('bridgeConfig', () => {
  it('is unset when neither variable is set', () => {
    expect(bridgeConfig({})).toEqual({ state: 'unset' });
    expect(bridgeConfig({ BACKUP_GDRIVE_WEBHOOK_URL: '  ', BACKUP_GDRIVE_SECRET: '' })).toEqual({ state: 'unset' });
  });

  it('accepts a deployed Web App URL and a long secret', () => {
    expect(bridgeConfig({ BACKUP_GDRIVE_WEBHOOK_URL: ` ${URL_OK} `, BACKUP_GDRIVE_SECRET: ` ${SECRET} ` }))
      .toEqual({ state: 'ok', config: { url: URL_OK, secret: SECRET } });
  });

  it.each([
    [{ BACKUP_GDRIVE_WEBHOOK_URL: URL_OK }, 'BACKUP_GDRIVE_SECRET is not'],
    [{ BACKUP_GDRIVE_SECRET: SECRET }, 'BACKUP_GDRIVE_WEBHOOK_URL is not'],
    [{ BACKUP_GDRIVE_WEBHOOK_URL: URL_OK, BACKUP_GDRIVE_SECRET: 'short' }, 'at least 32'],
    [{ BACKUP_GDRIVE_WEBHOOK_URL: 'not a url', BACKUP_GDRIVE_SECRET: SECRET }, 'not a URL'],
    [{ BACKUP_GDRIVE_WEBHOOK_URL: URL_OK.replace('https:', 'http:'), BACKUP_GDRIVE_SECRET: SECRET }, 'must be an https://'],
    [{ BACKUP_GDRIVE_WEBHOOK_URL: `https://evil.example/macros/s/${DEPLOYMENT}/exec`, BACKUP_GDRIVE_SECRET: SECRET }, 'must be an https://'],
    [{ BACKUP_GDRIVE_WEBHOOK_URL: `https://script.google.com.evil.example/macros/s/x/exec`, BACKUP_GDRIVE_SECRET: SECRET }, 'must be an https://'],
    [{ BACKUP_GDRIVE_WEBHOOK_URL: `https://user:pw@script.google.com/macros/s/x/exec`, BACKUP_GDRIVE_SECRET: SECRET }, 'must be an https://'],
    [{ BACKUP_GDRIVE_WEBHOOK_URL: `https://script.google.com/macros/s/${DEPLOYMENT}/dev`, BACKUP_GDRIVE_SECRET: SECRET }, 'end in /exec'],
  ])('rejects %o', (env, reason) => {
    const result = bridgeConfig(env);
    expect(result.state).toBe('invalid');
    if (result.state === 'invalid') {
      expect(result.reason).toContain(reason);
      expect(result.reason).not.toContain(SECRET);
    }
  });
});

describe('redact', () => {
  it('removes the secret and the deployment id wherever they appear', () => {
    const text = `failed ${SECRET} at ${URL_OK} (${SECRET})`;
    const safe = redact(text, CONFIG);
    expect(safe).not.toContain(SECRET);
    expect(safe).not.toContain(DEPLOYMENT);
    expect(safe).toBe('failed [redacted] at https://script.google.com/macros/s/[deployment]/exec ([redacted])');
  });
});

describe('payloads', () => {
  it('puts the secret and action in the JSON body, next to the fields', () => {
    expect(JSON.parse(buildPayload(SECRET, 'upload', {
      dir: '2026-11-25/tables', fileName: 'items.json', mimeType: 'application/json', encoding: 'utf8', content: '[]',
    }))).toEqual({
      secret: SECRET, action: 'upload', dir: '2026-11-25/tables', fileName: 'items.json',
      mimeType: 'application/json', encoding: 'utf8', content: '[]',
    });
    expect(JSON.parse(buildPayload(SECRET, 'list_folders', {}))).toEqual({ secret: SECRET, action: 'list_folders' });
    expect(JSON.parse(buildPayload(SECRET, 'trash_folder', { folderName: '2026-11-01' })))
      .toEqual({ secret: SECRET, action: 'trash_folder', folderName: '2026-11-01' });
  });

  it('only accepts folder paths and file names that stay inside the backup folder', () => {
    expect(validDir('2026-11-25/tables')).toBe(true);
    for (const bad of ['', '/abs', 'a//b', 'a/../b', '..', './x']) expect(validDir(bad)).toBe(false);
    expect(validFileName('items.json')).toBe(true);
    for (const bad of ['', 'a/b.json', 'a\\b', '..', '.', 'x'.repeat(201)]) expect(validFileName(bad)).toBe(false);
  });
});

describe('parseResponse', () => {
  it('returns the data of a successful answer', () => {
    expect(parseResponse('upload', 200, 'application/json', '{"ok":true,"id":"f1","name":"items.json"}'))
      .toEqual({ ok: true, id: 'f1', name: 'items.json' });
    expect(parseResponse('trash_folder', 200, null, '{"ok":true,"trashed":1}').trashed).toBe(1);
  });

  it('turns ok:false into a BridgeError carrying the bridge reason', () => {
    expect(() => parseResponse('upload', 200, 'application/json', '{"ok":false,"error":"unauthorised"}'))
      .toThrow(/bridge upload: unauthorised/);
  });

  it('never echoes a non-JSON body', () => {
    const page = '<html><title>Sign in – Google Accounts</title>private stuff</html>';
    try {
      parseResponse('list_folders', 200, 'text/html; charset=utf-8', page);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BridgeError);
      expect((error as Error).message).toContain('HTML page');
      expect((error as Error).message).not.toContain('private stuff');
    }
  });

  it('rejects an answer that does not match the protocol', () => {
    expect(() => parseResponse('list_folders', 200, 'application/json', '{"ok":true,"folders":"nope"}'))
      .toThrow(/did not match the protocol/);
  });
});

describe('foldersToTrash', () => {
  const day = (n: number) => `2026-11-${String(n).padStart(2, '0')}`;
  const folders = (names: string[]) => names.map((name, i) => ({ id: `id${i}`, name }));

  it('keeps the newest N run folders and trashes the rest, oldest first', () => {
    const names = Array.from({ length: 20 }, (_, i) => day(i + 1));
    expect(foldersToTrash(folders(names), KEEP_RUNS, day(20))).toEqual(names.slice(0, 6));
  });

  it('keeps everything when there are N or fewer runs', () => {
    expect(foldersToTrash(folders([day(1), day(2)]), KEEP_RUNS, day(2))).toEqual([]);
  });

  it('ignores folders that are not named like a run, and duplicates', () => {
    const list = folders(['files', 'notes', day(1), day(1), day(2), day(3)]);
    expect(foldersToTrash(list, 2, day(3))).toEqual([day(1)]);
  });

  it('never trashes today, even with keep below one', () => {
    expect(foldersToTrash(folders([day(1), day(2)]), 0, day(2))).toEqual([day(1)]);
    expect(foldersToTrash(folders([day(5)]), 0, day(5))).toEqual([]);
  });
});

describe('createBridgeClient', () => {
  it('POSTs JSON, follows the Apps Script redirect, and returns the upload result', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true, id: 'file-1', name: 'items.json' }));
    const client = createBridgeClient(CONFIG, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.upload({
      dir: '2026-11-25/tables', fileName: 'items.json', mimeType: 'application/json', encoding: 'utf8', content: '[]',
    })).resolves.toEqual({ id: 'file-1', name: 'items.json' });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(URL_OK);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('follow');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toMatchObject({ secret: SECRET, action: 'upload', fileName: 'items.json' });
  });

  it('redacts the secret if the bridge reflects it in an error', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: false, error: `bad secret ${SECRET} for ${DEPLOYMENT}` }));
    const client = createBridgeClient(CONFIG, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const error = await client.listFolders().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeError);
    expect((error as Error).message).not.toContain(SECRET);
    expect((error as Error).message).not.toContain(DEPLOYMENT);
    expect((error as Error).message).toContain('[redacted]');
  });

  it('reports a network failure without the request in it', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError(`fetch failed ${SECRET}`); });
    const client = createBridgeClient(CONFIG, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const error = await client.listFolders().catch((e: unknown) => e);
    expect((error as Error).message).toBe('bridge list_folders: could not be reached');
  });

  it('reports a timeout as a timeout', async () => {
    const fetchImpl = vi.fn(async () => { throw new DOMException('timed out', 'TimeoutError'); });
    const client = createBridgeClient(CONFIG, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.listFolders()).rejects.toThrow('bridge list_folders: timed out');
  });

  it('does not start a request with less than a second of budget left', async () => {
    const fetchImpl = vi.fn();
    const client = createBridgeClient(CONFIG, { fetchImpl: fetchImpl as unknown as typeof fetch, deadline: 1_500, now: () => 1_000 });
    await expect(client.listFolders()).rejects.toBeInstanceOf(BudgetExceeded);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses unsafe paths before any request', async () => {
    const fetchImpl = vi.fn();
    const client = createBridgeClient(CONFIG, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.upload({ dir: '../x', fileName: 'a.json', mimeType: 'application/json', encoding: 'utf8', content: '' }))
      .rejects.toThrow(/invalid folder/);
    await expect(client.trashFolder('files')).rejects.toThrow(/refusing/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('prunes: lists, then trashes only the folders past the newest N', async () => {
    const names = Array.from({ length: 16 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`);
    const sent: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      sent.push(body);
      if (body.action === 'list_folders') return json({ ok: true, folders: names.map((name) => ({ id: name, name, created: name })) });
      return json({ ok: true, trashed: 1 });
    });
    const client = createBridgeClient(CONFIG, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.prune(14, '2026-11-16')).resolves.toEqual(['2026-11-01', '2026-11-02']);
    expect(sent.map((b) => b.action)).toEqual(['list_folders', 'trash_folder', 'trash_folder']);
    expect(sent.slice(1).map((b) => b.folderName)).toEqual(['2026-11-01', '2026-11-02']);
  });
});
