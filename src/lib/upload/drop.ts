/**
 * Files from a drop, the same way an `<input type="file">` gives them.
 *
 * A dropped folder arrives as a directory entry, not as files. With
 * `folders`, entries are walked recursively and every file gets the
 * `relativePath` an `<input webkitdirectory>` would have given it
 * (`box1/a.jpg`), so the archive pairing engine sees no difference between
 * dropping a folder and choosing it. Without `webkitGetAsEntry` (or without
 * `folders`) the plain `dataTransfer.files` list is used.
 *
 * Browser-only, no network.
 */

export interface DroppedFile {
  file: File;
  /** Path inside a dropped folder, `folder/sub/name.ext`; absent for a loose file. */
  relativePath?: string;
}

/** The parts of the File and Directory Entries API used here. */
interface Entry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
}
interface FileEntry extends Entry {
  file(success: (file: File) => void, failure?: (error: unknown) => void): void;
}
interface DirectoryEntry extends Entry {
  createReader(): { readEntries(success: (entries: Entry[]) => void, failure?: (error: unknown) => void): void };
}

/** True when a drag carries files (not a link or selected text). */
export function dragHasFiles(transfer: DataTransfer | null): boolean {
  return Boolean(transfer && Array.from(transfer.types ?? []).includes('Files'));
}

function fileOf(entry: FileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** readEntries answers in batches (100 in Chrome); keep asking until it gives none. */
async function childrenOf(entry: DirectoryEntry): Promise<Entry[]> {
  const reader = entry.createReader();
  const all: Entry[] = [];
  for (;;) {
    const batch = await new Promise<Entry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

async function walk(entry: Entry, out: DroppedFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await fileOf(entry as FileEntry);
    // fullPath is "/box1/a.jpg" for a file in a dropped folder, "/a.jpg" for a loose file.
    const path = entry.fullPath.replace(/^\/+/, '');
    out.push(path.includes('/') ? { file, relativePath: path } : { file });
    return;
  }
  if (entry.isDirectory) {
    for (const child of await childrenOf(entry as DirectoryEntry)) await walk(child, out);
  }
}

export async function readDroppedFiles(transfer: DataTransfer, { folders = false } = {}): Promise<DroppedFile[]> {
  const items = Array.from(transfer.items ?? []);
  const canWalk = folders && items.length > 0 && items.every((item) => typeof item.webkitGetAsEntry === 'function');
  if (!canWalk) return Array.from(transfer.files ?? []).map((file) => ({ file }));

  // The entries must be taken now: the items list is emptied once the drop event returns.
  const entries = items
    .filter((item) => item.kind === 'file')
    .map((item) => item.webkitGetAsEntry() as Entry | null)
    .filter((entry): entry is Entry => entry !== null);
  if (entries.length === 0) return Array.from(transfer.files ?? []).map((file) => ({ file }));

  const out: DroppedFile[] = [];
  for (const entry of entries) {
    try {
      await walk(entry, out);
    } catch {
      // An unreadable entry (permissions, a vanished file) is left out; the rest still arrive.
    }
  }
  return out;
}
