import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { en, format } from '@/lib/i18n/messages';
import he from '@/lib/i18n/locales/he.json';
import { MessagesProvider } from '@/lib/i18n/provider';
import { readDroppedFiles } from '@/lib/upload/drop';

/**
 * Drag and drop on /archive-upload and /review/bulk-upload. A drop must do
 * exactly what the picker buttons do. Folders dropped on the archive upload
 * keep their relative paths, so pairing is the same as a folder pick. No
 * network, no Gemini.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => '/' }));
vi.mock('@/lib/files/upload', () => ({ uploadSignedFile: vi.fn() }));

const { ArchiveUploadFlow } = await import('@/components/archive-upload-flow');
const { BulkUploadFlow } = await import('@/components/bulk-upload-flow');
const { Dropzone } = await import('@/components/dropzone');

const HE = { ...en, ...(he as Record<string, string>) } as Record<string, string>;

// ── a DataTransfer, by hand (jsdom has none) ──────────────────────────────
interface MockEntry { isFile: boolean; isDirectory: boolean; name: string; fullPath: string; file?: unknown; createReader?: unknown }

function fileEntry(file: File, fullPath: string): MockEntry {
  return { isFile: true, isDirectory: false, name: file.name, fullPath, file: (ok: (f: File) => void) => ok(file) };
}
/** readEntries answers in batches, as Chrome does (100 at a time); here, two per batch. */
function dirEntry(name: string, fullPath: string, children: MockEntry[]): MockEntry {
  return {
    isFile: false, isDirectory: true, name, fullPath,
    createReader: () => {
      let at = 0;
      return { readEntries: (ok: (e: MockEntry[]) => void) => { const batch = children.slice(at, at + 2); at += 2; queueMicrotask(() => ok(batch)); } };
    },
  };
}
function transfer({ files = [] as File[], entries, types = ['Files'] }: { files?: File[]; entries?: MockEntry[]; types?: string[] }) {
  const items = entries
    ? entries.map((entry) => ({ kind: 'file', webkitGetAsEntry: () => entry }))
    : files.map(() => ({ kind: 'file' })); // no webkitGetAsEntry: the fallback path
  return { types, files, items, dropEffect: 'none' };
}

const jpg = (name: string) => new File(['x'], name, { type: 'image/jpeg' });
const txt = (name: string, text = 'notes') => new File([text], name, { type: 'text/plain' });
const zone = () => document.querySelector('[data-dropzone]') as HTMLElement;
const drop = async (el: HTMLElement, data: ReturnType<typeof transfer>) => {
  await act(async () => { fireEvent.drop(el, { dataTransfer: data }); });
};

beforeEach(() => {
  cleanup();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in this test'); }));
});

// ── the reader ─────────────────────────────────────────────────────────────
describe('reading a drop', () => {
  it('walks a dropped folder, in batches, keeping the paths a folder pick gives', async () => {
    const data = transfer({ entries: [
      dirEntry('box1', '/box1', [
        fileEntry(jpg('a__1.jpg'), '/box1/a__1.jpg'), fileEntry(jpg('a__2.jpg'), '/box1/a__2.jpg'),
        fileEntry(txt('a.txt'), '/box1/a.txt'),
        dirEntry('inner', '/box1/inner', [fileEntry(jpg('a.jpg'), '/box1/inner/a.jpg')]),
      ]),
      fileEntry(jpg('loose.jpg'), '/loose.jpg'),
    ] });
    const read = await readDroppedFiles(data as unknown as DataTransfer, { folders: true });
    expect(read.map((d) => [d.file.name, d.relativePath])).toEqual([
      ['a__1.jpg', 'box1/a__1.jpg'], ['a__2.jpg', 'box1/a__2.jpg'], ['a.txt', 'box1/a.txt'],
      ['a.jpg', 'box1/inner/a.jpg'], ['loose.jpg', undefined],
    ]);
  });

  it('falls back to the plain file list when entries are unavailable, or folders are not wanted', async () => {
    const files = [jpg('a.jpg'), jpg('b.jpg')];
    expect((await readDroppedFiles(transfer({ files }) as unknown as DataTransfer, { folders: true })).map((d) => d.file)).toEqual(files);
    const withEntries = { ...transfer({ entries: [fileEntry(files[0], '/a.jpg')] }), files };
    expect((await readDroppedFiles(withEntries as unknown as DataTransfer)).map((d) => d.file)).toEqual(files);
  });
});

// ── the zone itself ────────────────────────────────────────────────────────
describe('the dropzone', () => {
  const renderZone = (onFiles = vi.fn(), disabled = false) => {
    render(
      <MessagesProvider catalogue={HE}>
        <Dropzone prompt="Drag here" onFiles={onFiles} disabled={disabled}>
          <button type="button">Pick</button>
        </Dropzone>
      </MessagesProvider>,
    );
    return onFiles;
  };

  it('is not a control: no role, no tab stop, no click handler; the real button is inside', () => {
    renderZone();
    expect(zone()).not.toHaveAttribute('role');
    expect(zone()).not.toHaveAttribute('tabindex');
    expect(within(zone()).getByRole('button', { name: 'Pick' })).toBeInTheDocument();
  });

  it('highlights on drag-over, stays lit while crossing its children, and resets on leave and on drop', async () => {
    const onFiles = renderZone();
    const data = transfer({ files: [jpg('a.jpg')] });
    fireEvent.dragEnter(zone(), { dataTransfer: data });
    expect(zone()).toHaveAttribute('data-drag-over', 'true');
    expect(zone().className).toContain('border-primary-strong');
    expect(zone().className).toContain('bg-primary-wash');
    expect(zone()).toHaveTextContent(HE['dropzone.release']);

    const button = screen.getByRole('button', { name: 'Pick' });
    fireEvent.dragEnter(button, { dataTransfer: data }); // into the child…
    fireEvent.dragLeave(button, { dataTransfer: data }); // …and out of it
    expect(zone()).toHaveAttribute('data-drag-over', 'true');
    fireEvent.dragLeave(zone(), { dataTransfer: data });
    expect(zone()).not.toHaveAttribute('data-drag-over');
    expect(zone().className).toContain('border-control');
    expect(zone()).toHaveTextContent('Drag here');

    fireEvent.dragEnter(zone(), { dataTransfer: data });
    await drop(zone(), data);
    expect(zone()).not.toHaveAttribute('data-drag-over');
    expect(onFiles).toHaveBeenCalledWith([{ file: data.files[0] }]);
  });

  it('ignores a drag of text or a link, and drops nothing while disabled', async () => {
    const onFiles = renderZone(vi.fn(), true);
    fireEvent.dragEnter(zone(), { dataTransfer: transfer({ types: ['text/plain'] }) });
    expect(zone()).not.toHaveAttribute('data-drag-over');
    fireEvent.dragEnter(zone(), { dataTransfer: transfer({ files: [jpg('a.jpg')] }) });
    expect(zone()).not.toHaveAttribute('data-drag-over');
    await drop(zone(), transfer({ files: [jpg('a.jpg')] }));
    expect(onFiles).not.toHaveBeenCalled();
  });
});

// ── /archive-upload ────────────────────────────────────────────────────────
describe('dropping on /archive-upload', () => {
  const renderArchive = () => render(<MessagesProvider catalogue={HE}><ArchiveUploadFlow consentVersion="2026-09-07" expert /></MessagesProvider>);

  it('shows the prompt with both picker buttons inside the zone', () => {
    renderArchive();
    expect(zone()).toHaveTextContent(HE['archive.dropPrompt']);
    const inputs = Array.from(zone().querySelectorAll('input[type=file]'));
    expect(inputs.map((i) => (i as HTMLInputElement).labels?.[0]?.textContent?.trim())).toEqual([HE['archive.chooseFolder'], HE['archive.chooseFiles']]);
  });

  it('loose files go through the pairing engine: grouped items and the orphan .txt warning', async () => {
    renderArchive();
    await drop(zone(), transfer({ files: [jpg('w__2.jpg'), jpg('w__1.jpg'), txt('w.txt'), txt('lost.txt')] }));
    expect(screen.getByText(format(HE['archive.summary'], { items: 1, files: 4 }))).toBeInTheDocument();
    const item = screen.getByRole('heading', { name: 'w' }).closest('li')!;
    expect(within(item).getByText(HE['archive.hasText'])).toBeInTheDocument();
    expect(within(item).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['w__1.jpg', 'w__2.jpg']);
    const warning = screen.getAllByRole('alert').find((el) => el.textContent?.includes('lost.txt'))!;
    expect(warning).toHaveTextContent(format(HE['archive.orphans'], { count: 1 }));
  });

  it('a dropped folder pairs exactly like a folder pick: same names in different folders stay apart', async () => {
    renderArchive();
    await drop(zone(), transfer({ entries: [
      dirEntry('box1', '/box1', [fileEntry(jpg('a.jpg'), '/box1/a.jpg'), fileEntry(txt('a.txt'), '/box1/a.txt')]),
      dirEntry('box2', '/box2', [fileEntry(jpg('a.jpg'), '/box2/a.jpg'), fileEntry(jpg('a__1.jpg'), '/box2/a__1.jpg'), fileEntry(txt('b.txt'), '/box2/b.txt')]),
    ] }));
    await waitFor(() => expect(screen.getByText(format(HE['archive.summary'], { items: 2, files: 5 }))).toBeInTheDocument());
    const [first, second] = screen.getAllByRole('heading', { name: 'a' }).map((h) => h.closest('li')!);
    expect(within(first).getByText(HE['archive.hasText'])).toBeInTheDocument();
    expect(within(second).getByText(HE['archive.noText'])).toBeInTheDocument();
    expect(within(second).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['box2/a.jpg', 'box2/a__1.jpg']);
    expect(screen.getAllByRole('alert').some((el) => el.textContent?.includes('b.txt'))).toBe(true);
  });

  it('a drop adds to what was picked with the button', async () => {
    renderArchive();
    fireEvent.change(zone().querySelectorAll('input[type=file]')[1], { target: { files: [jpg('a__1.jpg')] } });
    await drop(zone(), transfer({ files: [jpg('a__2.jpg'), jpg('b.jpg')] }));
    expect(screen.getByText(format(HE['archive.summary'], { items: 2, files: 3 }))).toBeInTheDocument();
  });
});

// ── /review/bulk-upload ────────────────────────────────────────────────────
describe('dropping on a bulk-upload card', () => {
  const renderBulk = () => render(<MessagesProvider catalogue={HE}><BulkUploadFlow consentVersion="2026-09-07" /></MessagesProvider>);
  const mixed = () => [jpg('scan.jpg'), new File(['%PDF'], 'letter.pdf', { type: 'application/pdf' }), new File(['x'], 'song.mp3', { type: 'audio/mpeg' })];
  const outcome = () => {
    const card = screen.getByRole('article');
    return {
      files: within(card).queryAllByRole('button', { name: /^/ }).map((b) => b.getAttribute('aria-label')).filter((l) => l !== HE['bulk.remove'] && l?.startsWith(HE['bulk.removeFile'].split('{')[0])),
      alerts: within(card).queryAllByRole('alert').map((a) => a.textContent),
    };
  };

  it('puts the zone, with its prompt and the file button, in the card’s media area', () => {
    renderBulk();
    const media = screen.getByRole('group', { name: new RegExp(HE['bulk.media']) });
    expect(within(media).getByText(HE['bulk.dropPrompt'])).toBeInTheDocument();
    expect(media.querySelector('[data-dropzone] input[type=file]')).toHaveAccessibleName(HE['bulk.chooseFiles']);
  });

  it('accepted and refused files end the same whether dropped or picked', async () => {
    renderBulk();
    await drop(zone(), transfer({ files: mixed() }));
    const dropped = outcome();
    expect(dropped.files).toHaveLength(2);
    expect(dropped.alerts).toEqual([format(HE['bulk.err.fileType'], { name: 'song.mp3' })]);

    cleanup();
    renderBulk();
    fireEvent.change(zone().querySelector('input[type=file]')!, { target: { files: mixed() } });
    expect(outcome()).toEqual(dropped);
  });

  it('a later good drop clears the refusal, as a later good pick does', async () => {
    renderBulk();
    await drop(zone(), transfer({ files: [new File(['x'], 'song.mp3', { type: 'audio/mpeg' })] }));
    expect(screen.getByRole('alert')).toHaveTextContent('song.mp3');
    await drop(zone(), transfer({ files: [jpg('ok.jpg')] }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(outcome().files).toHaveLength(1);
  });
});
