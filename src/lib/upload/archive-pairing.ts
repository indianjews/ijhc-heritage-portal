import { bulkFileAccepted } from '@/lib/items/bulk-upload';

/**
 * Turning a folder of scans into archive items, by name. Pure and generic over
 * the file type, so the same rules serve the browser picker today and a
 * Google Drive import later.
 *
 * ── the naming convention ──────────────────────────────────────────────────
 *
 *   wedding_1954__1.jpg  ┐
 *   wedding_1954__2.jpg  ├─ one item, "wedding_1954", pages in order 1, 2, 10
 *   wedding_1954__10.jpg ┘
 *   wedding_1954.txt     ── its description; the item skips the AI reading
 *   photo_1954.jpg       ── an item of its own
 *   photo_1955.jpg       ── another: a single underscore is part of the name
 *
 * The group key is the folder path plus the name without its extension and
 * without a trailing `__<digits>`, trimmed and compared case-insensitively.
 * The folder is part of the key, so `box1/a.jpg` and `box2/a.jpg` stay apart
 * when a whole tree is chosen.
 */

/** What the engine needs to know about a file. `relativePath` comes from a folder pick. */
export interface PairableFile {
  name: string;
  type: string;
  relativePath?: string;
}

export interface ArchiveGroup<T extends PairableFile> {
  /** Folder + normalised name, lower-case: the identity of the item. */
  key: string;
  /** The name as written on the first file, without extension or `__N` — the item's working title. */
  displayName: string;
  /** Media in page order: no suffix first, then `__1`, `__2`, … `__10` numerically. */
  media: T[];
  /** The matching `.txt`, if any. Its text becomes the item's description. */
  text: T | null;
  /** True when a `.txt` describes the item: no AI reading is queued for it. */
  skipAi: boolean;
}

export interface ArchiveGrouping<T extends PairableFile> {
  items: ArchiveGroup<T>[];
  /** `.txt` files with no media of the same name: ignored, and the user is warned. */
  orphanTextFiles: T[];
  /** Files that are neither accepted media nor `.txt`. */
  skipped: T[];
}

/**
 * The MIME type for a name when the browser gave none — Windows often leaves
 * `.tif` and `.mov` without one. Only for the extensions the bulk upload
 * accepts; anything else stays unknown and is skipped.
 */
const BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  tif: 'image/tiff', tiff: 'image/tiff', pdf: 'application/pdf',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
};

function extension(name: string): string {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(name);
  return match ? match[1].toLowerCase() : '';
}

/** The type to use for a file: the browser's, or by extension when the browser gave none. */
export function mediaType(file: PairableFile): string {
  return file.type || BY_EXTENSION[extension(file.name)] || '';
}

export function isTextSidecar(file: PairableFile): boolean {
  return extension(file.name) === 'txt';
}

const SUFFIX = /__(\d+)$/;

/** The parts of a name the rules care about. Pure. */
export function parseArchiveName(file: PairableFile): { key: string; displayName: string; page: number | null } {
  const ext = extension(file.name);
  const stem = (ext ? file.name.slice(0, -(ext.length + 1)) : file.name).trim();
  const suffix = SUFFIX.exec(stem);
  const base = (suffix ? stem.slice(0, suffix.index) : stem).trim();
  const folder = folderOf(file);
  return {
    key: `${folder}/${base}`.normalize('NFC').toLocaleLowerCase(),
    displayName: base,
    page: suffix ? Number(suffix[1]) : null,
  };
}

function folderOf(file: PairableFile): string {
  const path = (file.relativePath || '').replace(/\\/g, '/');
  const cut = path.lastIndexOf('/');
  return cut > 0 ? path.slice(0, cut).normalize('NFC').toLocaleLowerCase() : '';
}

/** Groups a selection into archive items. Order of items follows the first file of each. */
export function groupArchiveFiles<T extends PairableFile>(files: T[]): ArchiveGrouping<T> {
  const groups = new Map<string, { displayName: string; media: { file: T; page: number | null; order: number }[]; text: T | null }>();
  const texts: { file: T; key: string }[] = [];
  const skipped: T[] = [];

  files.forEach((file, order) => {
    if (isTextSidecar(file)) {
      texts.push({ file, key: parseArchiveName(file).key });
      return;
    }
    if (!bulkFileAccepted(mediaType(file))) {
      skipped.push(file);
      return;
    }
    const { key, displayName, page } = parseArchiveName(file);
    const group = groups.get(key) ?? { displayName, media: [], text: null };
    group.media.push({ file, page, order });
    groups.set(key, group);
  });

  const orphanTextFiles: T[] = [];
  for (const { file, key } of texts) {
    const group = groups.get(key);
    // A second .txt for the same item is not silently merged: the first wins
    // and the extra one is reported with the orphans.
    if (group && !group.text) group.text = file;
    else orphanTextFiles.push(file);
  }

  const items = [...groups.entries()].map(([key, group]) => ({
    key,
    displayName: group.displayName,
    media: group.media
      .sort((a, b) => (a.page ?? -1) - (b.page ?? -1) || a.order - b.order)
      .map((entry) => entry.file),
    text: group.text,
    skipAi: Boolean(group.text),
  }));
  return { items, orphanTextFiles, skipped };
}

/** A sidecar's text as stored: UTF-8 with any byte-order mark removed, line endings normalised, trimmed. */
export function sidecarText(raw: string): string {
  return raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
}

/** The longest description a sidecar may carry (a full transcription fits). */
export const MAX_SIDECAR_CHARS = 100_000;
