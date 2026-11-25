import 'server-only';
import { z } from 'zod';

/**
 * The Google Drive destination, through a Google Apps Script Web App.
 *
 * ── why a bridge and not the Drive API ──────────────────────────────────────
 *
 * The Drive API needs an OAuth client or a service account, a Google Cloud
 * project and a refresh-token dance, all to write a few JSON files a night into
 * one folder. An Apps Script deployed as a Web App runs as the Center's own
 * Google account, owns the folder, and needs one URL and one shared secret.
 *
 * ── the protocol, and two things about Apps Script it has to respect ────────
 *
 * Every call is a `POST` of JSON to the deployment's `/exec` URL:
 *
 *   { secret, action: 'upload', dir, fileName, mimeType, encoding, content }
 *   { secret, action: 'list_folders' }
 *   { secret, action: 'trash_folder', folderName }
 *
 * and the answer is `{ ok: true, ... }` or `{ ok: false, error }`.
 *
 * 1. Apps Script drops custom request headers, so the secret travels in the
 *    JSON body. That is only acceptable over HTTPS to Google's own host, which
 *    is why `bridgeConfig()` refuses any other URL rather than trusting it.
 * 2. The response is a 302 to `script.googleusercontent.com`. `fetch` follows
 *    it as a GET (the standard behaviour for a 302 after a POST), which is what
 *    Apps Script expects — and the body, with the secret in it, is not resent.
 *
 * ── extending it ────────────────────────────────────────────────────────────
 *
 * `BridgeActions` is the whole protocol in one type: an action name, what it
 * sends, and the schema its answer must match. Adding `list_files`,
 * `download` or `move` for a staged collection import is one entry there plus
 * the matching branch in the Apps Script; `call()` does not change.
 *
 * ── the secret never leaves this file in a message ──────────────────────────
 *
 * Every error raised here is a `BridgeError` whose message has been through
 * `redact()`: the secret and the deployment id in the URL are replaced before
 * anything reaches a log, the problems table or a cron response. The bridge's
 * own body is never echoed when it is not the JSON the protocol promises —
 * an HTML page from Google is a login screen, and there is nothing in it worth
 * recording.
 */

/** A deployed Apps Script Web App lives here, and only here. */
export const BRIDGE_HOST = 'script.google.com';

/** Long enough that it was generated, not typed (`openssl rand -hex 32` gives 64). */
export const MIN_SECRET_LENGTH = 32;

/** Runs kept on Drive. A fortnight, the same as `scripts/backup.ts`. */
export const KEEP_RUNS = 14;

/** One request may not take longer than this, whatever budget is left. */
export const REQUEST_TIMEOUT_MS = 20_000;

/** Run folders are named by day. Anything else in the backup folder is not ours to prune. */
const RUN_FOLDER = /^\d{4}-\d{2}-\d{2}$/;

export interface BridgeConfig {
  url: string;
  secret: string;
}

export type BridgeConfigResult =
  | { state: 'unset' }
  | { state: 'invalid'; reason: string }
  | { state: 'ok'; config: BridgeConfig };

/**
 * The bridge, read from the environment and checked.
 *
 * Unset is a real state (the S3 destination may be the one in use). Half-set
 * or wrong is not: it is reported as `invalid`, with a reason that never
 * contains the secret, so a typo in Vercel's settings is not mistaken for a
 * deliberate choice and silently backed up somewhere else.
 */
export function bridgeConfig(env: Record<string, string | undefined> = process.env): BridgeConfigResult {
  const url = env.BACKUP_GDRIVE_WEBHOOK_URL?.trim();
  const secret = env.BACKUP_GDRIVE_SECRET?.trim();
  if (!url && !secret) return { state: 'unset' };
  if (!url) return { state: 'invalid', reason: 'BACKUP_GDRIVE_SECRET is set but BACKUP_GDRIVE_WEBHOOK_URL is not.' };
  if (!secret) return { state: 'invalid', reason: 'BACKUP_GDRIVE_WEBHOOK_URL is set but BACKUP_GDRIVE_SECRET is not.' };
  if (secret.length < MIN_SECRET_LENGTH) {
    return { state: 'invalid', reason: `BACKUP_GDRIVE_SECRET must be at least ${MIN_SECRET_LENGTH} characters.` };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { state: 'invalid', reason: 'BACKUP_GDRIVE_WEBHOOK_URL is not a URL.' };
  }
  // The secret is in the body, so where the body goes is the security boundary.
  if (parsed.protocol !== 'https:' || parsed.hostname !== BRIDGE_HOST || parsed.username || parsed.password) {
    return { state: 'invalid', reason: `BACKUP_GDRIVE_WEBHOOK_URL must be an https://${BRIDGE_HOST}/macros/s/…/exec address.` };
  }
  if (!/^\/macros\/s\/[\w-]+\/exec$/.test(parsed.pathname)) {
    return { state: 'invalid', reason: 'BACKUP_GDRIVE_WEBHOOK_URL must end in /exec (the deployed Web App, not /dev).' };
  }
  return { state: 'ok', config: { url: parsed.href, secret } };
}

/**
 * Text made safe to log.
 *
 * The secret is replaced wherever it appears, and so is the deployment id: the
 * URL alone is not a credential, but there is no reason to publish where the
 * archive's database lands every night.
 */
export function redact(text: string, config: Pick<BridgeConfig, 'url' | 'secret'>): string {
  let out = text;
  if (config.secret) out = out.split(config.secret).join('[redacted]');
  const id = /\/macros\/s\/([\w-]+)\//.exec(config.url)?.[1];
  if (id) out = out.split(id).join('[deployment]');
  return out;
}

export class BridgeError extends Error {
  constructor(
    message: string,
    readonly action: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

/** The run is out of time. Not a fault of the bridge; the caller stops cleanly. */
export class BudgetExceeded extends Error {
  constructor() {
    super('backup time budget exhausted');
    this.name = 'BudgetExceeded';
  }
}

// ── the protocol ────────────────────────────────────────────────────────────

const Folder = z.object({ id: z.string(), name: z.string(), created: z.string().optional() });
export type DriveFolder = z.infer<typeof Folder>;

export interface UploadInput {
  /** Slash-separated folder path under the backup root, e.g. `2026-11-25/tables`. */
  dir: string;
  fileName: string;
  mimeType: string;
  encoding: 'utf8' | 'base64';
  content: string;
}

export const BridgeActions = {
  upload: {
    request: (input: UploadInput) => ({ ...input }),
    response: z.object({ ok: z.literal(true), id: z.string(), name: z.string() }),
  },
  list_folders: {
    request: () => ({}),
    response: z.object({ ok: z.literal(true), folders: z.array(Folder) }),
  },
  trash_folder: {
    request: (folderName: string) => ({ folderName }),
    response: z.object({ ok: z.literal(true), trashed: z.number().int().nonnegative() }),
  },
} as const;

export type BridgeAction = keyof typeof BridgeActions;

const Failure = z.object({ ok: z.literal(false), error: z.string().optional() });

/** A path inside the backup folder: no empty, `.` or `..` segments, no leading slash. */
export function validDir(dir: string): boolean {
  return dir.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    && !dir.startsWith('/');
}

/** A file name with no path in it. */
export function validFileName(name: string): boolean {
  return name.length > 0 && name.length <= 200 && !/[/\\]/.test(name) && name !== '.' && name !== '..';
}

/** The exact JSON body for one call. Pure, so it can be checked without a network. */
export function buildPayload(secret: string, action: BridgeAction, fields: Record<string, unknown>): string {
  return JSON.stringify({ secret, action, ...fields });
}

/**
 * The bridge's answer, checked against what this action promises.
 *
 * Anything else is an error that says what was wrong — never what came back,
 * which for a misdeployed script is Google's sign-in page.
 */
export function parseResponse<A extends BridgeAction>(
  action: A,
  status: number,
  contentType: string | null,
  text: string,
): z.infer<(typeof BridgeActions)[A]['response']> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    const kind = contentType?.includes('html') ? 'an HTML page (is the Web App deployed for "Anyone"?)' : 'something that is not JSON';
    throw new BridgeError(`bridge ${action}: HTTP ${status}, returned ${kind}`, action, status);
  }
  const failed = Failure.safeParse(json);
  if (failed.success) {
    throw new BridgeError(`bridge ${action}: ${failed.data.error?.slice(0, 300) || 'refused without a reason'}`, action, status);
  }
  const parsed = BridgeActions[action].response.safeParse(json);
  if (!parsed.success) {
    throw new BridgeError(`bridge ${action}: HTTP ${status}, answer did not match the protocol`, action, status);
  }
  return parsed.data as z.infer<(typeof BridgeActions)[A]['response']>;
}

/**
 * Which run folders to trash: everything but the newest `keep` day-named
 * folders. Today's is never in the list, whatever the count, and folders that
 * are not named like a run are left alone.
 */
export function foldersToTrash(folders: DriveFolder[], keep: number, today: string): string[] {
  const runs = [...new Set(folders.map((f) => f.name).filter((name) => RUN_FOLDER.test(name)))].sort();
  const old = runs.slice(0, Math.max(0, runs.length - Math.max(1, keep)));
  return old.filter((name) => name !== today);
}

// ── the client ──────────────────────────────────────────────────────────────

export interface BridgeClient {
  upload(input: UploadInput): Promise<{ id: string; name: string }>;
  listFolders(): Promise<DriveFolder[]>;
  trashFolder(folderName: string): Promise<number>;
  /** Keeps the newest `keep` runs; returns the folder names it trashed. */
  prune(keep: number, today: string): Promise<string[]>;
}

export interface ClientOptions {
  /** Epoch ms after which no new request is started. */
  deadline?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function createBridgeClient(config: BridgeConfig, options: ClientOptions = {}): BridgeClient {
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  async function call<A extends BridgeAction>(action: A, fields: Record<string, unknown>) {
    const left = options.deadline === undefined ? REQUEST_TIMEOUT_MS : options.deadline - now();
    // Under a second is not enough for Apps Script to answer; do not start.
    if (left < 1_000) throw new BudgetExceeded();
    let response: Response;
    try {
      response = await doFetch(config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: buildPayload(config.secret, action, fields),
        redirect: 'follow',
        cache: 'no-store',
        signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, left)),
      });
    } catch (error) {
      // By name: a DOMException is not an Error in every runtime.
      const reason = (error as { name?: unknown } | null)?.name === 'TimeoutError' ? 'timed out' : 'could not be reached';
      throw new BridgeError(`bridge ${action}: ${reason}`, action);
    }
    const text = await response.text().catch(() => '');
    try {
      return parseResponse(action, response.status, response.headers.get('content-type'), text);
    } catch (error) {
      if (error instanceof BridgeError) throw new BridgeError(redact(error.message, config), action, error.status);
      throw error;
    }
  }

  const client: BridgeClient = {
    async upload(input) {
      if (!validDir(input.dir)) throw new BridgeError(`bridge upload: invalid folder "${input.dir}"`, 'upload');
      if (!validFileName(input.fileName)) throw new BridgeError(`bridge upload: invalid file name "${input.fileName}"`, 'upload');
      const { id, name } = await call('upload', BridgeActions.upload.request(input));
      return { id, name };
    },
    async listFolders() {
      return (await call('list_folders', BridgeActions.list_folders.request())).folders;
    },
    async trashFolder(folderName) {
      if (!RUN_FOLDER.test(folderName)) throw new BridgeError(`bridge trash_folder: refusing "${folderName}"`, 'trash_folder');
      return (await call('trash_folder', BridgeActions.trash_folder.request(folderName))).trashed;
    },
    async prune(keep, today) {
      const trashed: string[] = [];
      for (const name of foldersToTrash(await client.listFolders(), keep, today)) {
        if ((await client.trashFolder(name)) > 0) trashed.push(name);
      }
      return trashed;
    },
  };
  return client;
}
