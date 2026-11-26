import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextRequest } from 'next/server';
import { en, format, type MessageKey } from '@/lib/i18n/messages';
import he from '@/lib/i18n/locales/he.json';
import { MessagesProvider } from '@/lib/i18n/provider';
import { groupArchiveFiles, mediaType, parseArchiveName, sidecarText } from '@/lib/upload/archive-pairing';
import { archiveUploadAccess, israelToday, validateWindow, windowState } from '@/lib/upload/archive-access';
import type { Profile } from '@/lib/types';

/**
 * Archive upload: the pairing engine, the access rule and its boundaries
 * (0043), the navigation for each kind of account, the administrators'
 * window, and the screen. No network, no live Gemini.
 */

const HE = he as Record<string, string>;
const HEB = { ...en, ...HE } as Record<string, string>;
const english = (key: MessageKey, vars?: Record<string, string | number>) => format(en[key], vars);

// ── shared mocks ───────────────────────────────────────────────────────────
const m = vi.hoisted(() => ({
  pathname: '/',
  /** The session: a user and their profile row, or null. */
  session: null as null | { user: { id: string }; profile: Record<string, unknown> | null },
  /** What can_archive_upload() returns, or an error. */
  rpc: { data: false as unknown, error: null as null | { message: string } },
  createItem: vi.fn(async (input: Record<string, unknown>) => ({ id: 'item-1', title: String(input.title) })),
  setWindow: vi.fn(async () => true),
}));
vi.mock('next/navigation', () => ({ usePathname: () => m.pathname, useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), redirect: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], set: () => {}, get: () => undefined }) }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: m.session?.user ?? null }, error: null }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: m.session?.profile ?? null, error: null }) }) }) }),
    rpc: async (name: string) => (name === 'can_archive_upload' ? m.rpc : { data: null, error: { message: 'unknown' } }),
  }),
}));
vi.mock('@/lib/i18n', () => ({ getMessages: async () => ({ t: english, language: { code: 'en' } }) }));
vi.mock('@/lib/items/mutations', () => ({ createItem: m.createItem }));
vi.mock('@/lib/vocabulary/mutations', () => ({ setArchiveWindow: m.setWindow, setAccountRole: vi.fn(), setAccountNotices: vi.fn(), declineAccount: vi.fn() }));
vi.mock('@/lib/files/upload', () => ({ uploadSignedFile: vi.fn(async () => ({ error: null })) }));
vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key-for-grants');

const { issueGrant } = await import('@/lib/files/grant');
const { getArchiveUploader } = await import('@/lib/upload/archive-access-server');
const { getCurrentVolunteer } = await import('@/lib/supabase/server');
const { POST: archiveUpload } = await import('@/app/api/items/archive-upload/route');
const { POST: bulkUpload } = await import('@/app/api/items/bulk-upload-item/route');
const { PATCH: patchAccount } = await import('@/app/api/manage/accounts/[id]/route');
const { isArchiveUpload } = await import('@/proxy');
const { PrimaryNav, ArchiveNav } = await import('@/components/site-nav');
const { ArchiveWindowEditor } = await import('@/components/archive-window-editor');
const { ArchiveUploadFlow } = await import('@/components/archive-upload-flow');

const TODAY = israelToday();
const shift = (days: number) => { const d = new Date(`${TODAY}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const profile = (role: string, from: string | null = null, until: string | null = null) =>
  ({ id: `${role}-1`, email: `${role}@example.org`, full_name: 'Dina', role, archive_upload_from: from, archive_upload_until: until }) as unknown as Profile;
const signIn = (p: Profile | null) => { m.session = p ? { user: { id: p.id }, profile: p as unknown as Record<string, unknown> } : null; };

beforeEach(() => {
  cleanup();
  m.pathname = '/'; m.session = null; m.rpc = { data: false, error: null };
  m.createItem.mockClear(); m.setWindow.mockClear(); m.setWindow.mockResolvedValue(true);
});

// ── Part 1: pairing ────────────────────────────────────────────────────────
describe('pairing files into archive items', () => {
  const f = (name: string, type = '', relativePath?: string) => ({ name, type, relativePath });

  it('pairs __1, __2, __10 into one item, in numeric order, unsuffixed first', () => {
    const { items } = groupArchiveFiles([f('wedding_1954__10.jpg'), f('wedding_1954__2.jpg'), f('Wedding_1954.jpg'), f('wedding_1954__1.jpg')]);
    expect(items).toHaveLength(1);
    expect(items[0].media.map((x) => x.name)).toEqual(['Wedding_1954.jpg', 'wedding_1954__1.jpg', 'wedding_1954__2.jpg', 'wedding_1954__10.jpg']);
    // The working title is the name as written on the first file picked.
    expect(items[0].displayName).toBe('wedding_1954');
  });

  it('keeps single-underscore numbers apart', () => {
    const { items } = groupArchiveFiles([f('photo_1954.jpg'), f('photo_1955.jpg'), f('photo_1954_2.jpg')]);
    expect(items.map((i) => i.media.map((x) => x.name))).toEqual([['photo_1954.jpg'], ['photo_1955.jpg'], ['photo_1954_2.jpg']]);
  });

  it('attaches a matching .txt and marks the item to skip the AI', () => {
    const { items, orphanTextFiles } = groupArchiveFiles([f('ketuba__1.tif'), f('ketuba__2.tif'), f('KETUBA.txt', 'text/plain'), f('letter.pdf')]);
    const ketuba = items.find((i) => i.displayName === 'ketuba')!;
    expect(ketuba.text?.name).toBe('KETUBA.txt');
    expect(ketuba.skipAi).toBe(true);
    const letter = items.find((i) => i.displayName === 'letter')!;
    expect(letter.text).toBeNull();
    expect(letter.skipAi).toBe(false);
    expect(orphanTextFiles).toEqual([]);
  });

  it('reports orphan .txt files without creating items, and a second .txt for the same item', () => {
    const { items, orphanTextFiles } = groupArchiveFiles([f('a.jpg'), f('a.txt'), f('a__1.txt'), f('lonely.txt')]);
    expect(items).toHaveLength(1);
    expect(orphanTextFiles.map((x) => x.name)).toEqual(['a__1.txt', 'lonely.txt']);
  });

  it('skips unsupported files, and recognises media by extension when the browser gave no type', () => {
    const { items, skipped } = groupArchiveFiles([f('notes.docx'), f('song.mp3', 'audio/mpeg'), f('scan.tif'), f('clip.MOV'), f('x.svg', 'image/svg+xml')]);
    expect(skipped.map((x) => x.name)).toEqual(['notes.docx', 'song.mp3', 'x.svg']);
    expect(items.map((i) => i.displayName)).toEqual(['scan', 'clip']);
    expect(mediaType(f('scan.TIFF'))).toBe('image/tiff');
  });

  it('keeps the same name in different folders apart', () => {
    const { items } = groupArchiveFiles([f('a.jpg', '', 'box1/a.jpg'), f('a.jpg', '', 'box2/a.jpg'), f('a.txt', '', 'box1/a.txt')]);
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.key.startsWith('box1'))!.skipAi).toBe(true);
    expect(items.find((i) => i.key.startsWith('box2'))!.skipAi).toBe(false);
    expect(parseArchiveName(f('x__3.jpg', '', 'Box/x__3.jpg'))).toEqual({ key: 'box/x', displayName: 'x', page: 3 });
  });

  it('cleans sidecar text: BOM, Windows line endings, surrounding space', () => {
    expect(sidecarText('﻿  Wedding, Mumbai\r\n1954  \r\n')).toBe('Wedding, Mumbai\n1954');
  });
});

// ── Part 2: access ─────────────────────────────────────────────────────────
describe('who may use the archive upload', () => {
  it('experts and administrators always', () => {
    expect(archiveUploadAccess(profile('volunteer'), TODAY)).toBe('expert');
    expect(archiveUploadAccess(profile('admin'), TODAY)).toBe('expert');
  });

  it('a pending account only inside its window, both ends inclusive', () => {
    expect(archiveUploadAccess(profile('pending', TODAY, TODAY), TODAY)).toBe('window');
    expect(archiveUploadAccess(profile('pending', shift(-3), shift(3)), TODAY)).toBe('window');
    expect(archiveUploadAccess(profile('pending', shift(1), shift(3)), TODAY)).toBeNull();   // before
    expect(archiveUploadAccess(profile('pending', shift(-3), shift(-1)), TODAY)).toBeNull(); // after
    expect(archiveUploadAccess(profile('pending'), TODAY)).toBeNull();                       // none
    expect(archiveUploadAccess(null, TODAY)).toBeNull();                                     // anonymous
  });

  it('uses the Israel calendar', () => {
    // 22:30 UTC on 30 Nov is already 1 Dec in Jerusalem.
    expect(israelToday(new Date('2026-11-30T22:30:00Z'))).toBe('2026-12-01');
    expect(windowState({ archive_upload_from: '2026-12-01', archive_upload_until: '2026-12-01' }, israelToday(new Date('2026-11-30T22:30:00Z')))).toBe('active');
  });

  it('validates an administrator’s dates', () => {
    expect(validateWindow(null, null)).toBeNull();
    expect(validateWindow('2026-12-01', '2026-12-01')).toBeNull();
    expect(validateWindow('2026-12-01', null)).toBe('accounts.window.err.both');
    expect(validateWindow('2026-12-05', '2026-12-01')).toBe('accounts.window.err.order');
    expect(validateWindow('2026-02-30', '2026-03-01')).toBe('accounts.window.err.date');
  });

  describe('the server check asks the database', () => {
    it('grants an expert, and a pending account the database allows', async () => {
      signIn(profile('volunteer')); m.rpc = { data: true, error: null };
      expect(await getArchiveUploader()).toMatchObject({ access: 'expert' });
      signIn(profile('pending', shift(-1), shift(1))); m.rpc = { data: true, error: null };
      expect(await getArchiveUploader()).toMatchObject({ access: 'window' });
    });

    it('refuses when the database says no — even if the dates look open locally', async () => {
      signIn(profile('pending', shift(-1), shift(1))); m.rpc = { data: false, error: null };
      expect(await getArchiveUploader()).toBeNull();
    });

    it('refuses anonymous visitors', async () => {
      expect(await getArchiveUploader()).toBeNull();
    });

    it('without migration 0043, keeps experts and refuses everyone else', async () => {
      m.rpc = { data: null, error: { message: 'function can_archive_upload() does not exist' } };
      signIn(profile('admin'));
      expect(await getArchiveUploader()).toMatchObject({ access: 'expert' });
      signIn(profile('pending', shift(-1), shift(1)));
      expect(await getArchiveUploader()).toBeNull();
    });
  });

  describe('a window opens this screen and nothing else', () => {
    beforeEach(() => { signIn(profile('pending', shift(-1), shift(1))); m.rpc = { data: true, error: null }; });

    it('is not a content expert: every /review and /manage guard still says no', async () => {
      expect(await getCurrentVolunteer()).toBeNull();
    });

    it('cannot use the experts’ bulk upload', async () => {
      const response = await bulkUpload(new NextRequest('https://a.example/api/items/bulk-upload-item', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      }));
      expect(response.status).toBe(401);
    });

    it('the proxy gates only the archive-upload screen itself, not its no-access page', () => {
      expect(isArchiveUpload('/archive-upload')).toBe(true);
      expect(isArchiveUpload('/archive-upload/no-access')).toBe(false);
      expect(isArchiveUpload('/review')).toBe(false);
    });
  });
});

// ── Part 5: the route ──────────────────────────────────────────────────────
describe('POST /api/items/archive-upload', () => {
  const file = (name: string, mimeType: string) => {
    const path = `uploads/2026/11/x-${name}`;
    return { path, ...issueGrant(path), fileName: name, mimeType, byteSize: 100 };
  };
  const post = (body: Record<string, unknown>) => archiveUpload(new NextRequest('https://a.example/api/items/archive-upload', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.3.0.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify({ name: 'wedding_1954', skipAi: false, periodUnknown: true, creditRequired: false, consentVersion: '2026-09-07',
      files: [file('w__1.jpg', 'image/jpeg'), file('w.mp4', 'video/mp4')], ...body }),
  }));

  it('refuses anyone the database refuses (anonymous, or pending outside the window)', async () => {
    expect((await post({})).status).toBe(403);
    signIn(profile('pending', shift(1), shift(2))); m.rpc = { data: false, error: null };
    expect((await post({})).status).toBe(403);
    expect(m.createItem).not.toHaveBeenCalled();
  });

  it('with a .txt: stores the text and queues no AI reading at all', async () => {
    signIn(profile('admin')); m.rpc = { data: true, error: null };
    expect((await post({ skipAi: true, description: 'Wedding in Mumbai, 1954.' })).status).toBe(201);
    const input = m.createItem.mock.calls[0][0] as { files: Record<string, unknown>[] } & Record<string, unknown>;
    expect(input).toMatchObject({ contributorDescription: 'Wedding in Mumbai, 1954.', title: 'wedding 1954', uploadedBy: 'admin-1', contributorEmail: null });
    expect(input.files.every((f) => f.noAnalysis === true && f.analysisQueued === false)).toBe(true);
  });

  it('without a .txt: queues the image, never the video', async () => {
    signIn(profile('volunteer')); m.rpc = { data: true, error: null };
    await post({});
    const files = (m.createItem.mock.calls[0][0] as { files: Record<string, unknown>[] }).files;
    expect(files.map((f) => [f.mimeType, f.analysisQueued, f.noAnalysis])).toEqual([['image/jpeg', true, false], ['video/mp4', false, true]]);
  });

  it('records a windowed account as the contributor, with a receipt link', async () => {
    signIn(profile('pending', shift(-1), shift(1))); m.rpc = { data: true, error: null };
    const response = await post({});
    expect(response.status).toBe(201);
    expect((await response.json()).data.receipt).toBeTruthy();
    expect(m.createItem.mock.calls[0][0]).toMatchObject({ uploadedBy: 'pending-1', contributorEmail: 'pending@example.org', consentVersion: '2026-09-07' });
    expect(m.createItem.mock.calls[0][0]).not.toHaveProperty('status');
  });

  it('refuses skipping the AI without text, and unanswered batch fields', async () => {
    signIn(profile('admin')); m.rpc = { data: true, error: null };
    const res = await post({ skipAi: true, description: '  ', periodUnknown: false });
    expect(res.status).toBe(400);
    expect((await res.json()).error.fields).toMatchObject({ description: 'archive.err.noText', period: 'bulk.err.period' });
    const noCredit = await post({ creditRequired: undefined });
    expect(noCredit.status).toBe(400);
    expect((await noCredit.json()).error.fields).toMatchObject({ creditRequired: 'bulk.err.credit' });
    expect(m.createItem).not.toHaveBeenCalled();
  });
});

// ── Part 3: the administrators' window ─────────────────────────────────────
describe('/manage/accounts window', () => {
  const patch = (body: unknown) => patchAccount(new NextRequest('https://a.example/api/manage/accounts/p-1', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: 'p-1' }) });

  it('is administrators only', async () => {
    signIn(profile('volunteer'));
    expect((await patch({ archiveUploadFrom: TODAY, archiveUploadUntil: TODAY })).status).toBe(403);
    expect(m.setWindow).not.toHaveBeenCalled();
  });

  it('sets, validates and clears', async () => {
    signIn(profile('admin'));
    expect((await patch({ archiveUploadFrom: '2026-12-01', archiveUploadUntil: '2026-12-10' })).status).toBe(200);
    expect(m.setWindow).toHaveBeenLastCalledWith('p-1', '2026-12-01', '2026-12-10');
    expect((await (await patch({ archiveUploadFrom: '2026-12-10', archiveUploadUntil: '2026-12-01' })).json()).error.message).toBe('accounts.window.err.order');
    expect((await (await patch({ archiveUploadFrom: '2026-12-10', archiveUploadUntil: null })).json()).error.message).toBe('accounts.window.err.both');
    expect((await patch({ archiveUploadFrom: null, archiveUploadUntil: null })).status).toBe(200);
    expect(m.setWindow).toHaveBeenLastCalledWith('p-1', null, null);
  });

  it('refuses an account that is not pending', async () => {
    signIn(profile('admin')); m.setWindow.mockResolvedValueOnce(false);
    expect((await patch({ archiveUploadFrom: TODAY, archiveUploadUntil: TODAY })).status).toBe(409);
  });

  it('the editor shows the state, labels both dates, and announces a validation error on the fields', async () => {
    render(<MessagesProvider catalogue={HEB}><ArchiveWindowEditor profile={profile('pending', shift(-1), shift(2))} /></MessagesProvider>);
    expect(screen.getByText(format(HE['accounts.window.active'], { from: shift(-1), until: shift(2) }))).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(HE['accounts.window.until']), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: HE['accounts.window.save'] }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(HE['accounts.window.err.both']);
    expect(screen.getByLabelText(HE['accounts.window.from'])).toHaveAttribute('aria-describedby', alert.id);
    expect(screen.getByLabelText(HE['accounts.window.until'])).toHaveAttribute('aria-invalid', 'true');
  });
});

// ── Part 4: navigation ─────────────────────────────────────────────────────
describe('navigation', () => {
  const nav = (ui: React.ReactNode) => render(<MessagesProvider catalogue={HEB}>{ui}</MessagesProvider>);

  it.each(['volunteer', 'admin'] as const)('a %s finds it in the Archive menu', (role) => {
    nav(<ArchiveNav profile={profile(role)} queueCount={0} layout="bar" />);
    expect(screen.getByRole('link', { name: HE['nav.archiveUpload'] })).toHaveAttribute('href', '/archive-upload');
  });

  it('a windowed pending account gets it in the main bar, right after Contribute — bar and panel', () => {
    for (const layout of ['bar', 'panel'] as const) {
      cleanup();
      nav(<PrimaryNav layout={layout} archiveUpload />);
      const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
      expect(hrefs.indexOf('/archive-upload')).toBe(hrefs.indexOf('/upload') + 1);
    }
  });

  it('nobody else sees it: anonymous, pending without a window, and the main bar of experts', () => {
    nav(<PrimaryNav layout="bar" />);
    expect(screen.queryByRole('link', { name: HE['nav.archiveUpload'] })).toBeNull();
    cleanup();
    const { container } = nav(<ArchiveNav profile={profile('pending', shift(-1), shift(1))} queueCount={0} layout="bar" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('the masthead decides from the dates: only an open window shows the main-bar link', () => {
    expect(archiveUploadAccess(profile('pending', shift(-1), shift(1)), TODAY)).toBe('window');
    for (const p of [null, profile('pending'), profile('pending', shift(1), shift(2)), profile('volunteer')]) {
      expect(archiveUploadAccess(p, TODAY) === 'window').toBe(false);
    }
  });
});

// ── Part 5: the screen ─────────────────────────────────────────────────────
describe('/archive-upload screen', () => {
  const pick = (input: HTMLElement, files: File[]) => fireEvent.change(input, { target: { files } });
  const fileInputs = () => Array.from(document.querySelectorAll('input[type=file]')) as HTMLInputElement[];
  const renderFlow = () => render(<MessagesProvider catalogue={HEB}><ArchiveUploadFlow consentVersion="2026-09-07" expert /></MessagesProvider>);

  it('offers a folder picker and a files picker, both labelled', () => {
    renderFlow();
    const [folder, files] = fileInputs();
    expect(folder).toHaveAttribute('webkitdirectory');
    expect(folder).toHaveAccessibleName(HE['archive.chooseFolder']);
    expect(files).toHaveAccessibleName(HE['archive.chooseFiles']);
  });

  it('shows the grouped items with their AI decision, skipped files, and the orphan warning beside the button', () => {
    renderFlow();
    pick(fileInputs()[1], [
      new File(['a'], 'wedding_1954__2.jpg', { type: 'image/jpeg' }), new File(['a'], 'wedding_1954__1.jpg', { type: 'image/jpeg' }),
      new File(['text'], 'wedding_1954.txt', { type: 'text/plain' }), new File(['a'], 'letter.pdf', { type: 'application/pdf' }),
      new File(['x'], 'lost.txt', { type: 'text/plain' }), new File(['x'], 'notes.docx', { type: '' }),
    ]);
    expect(screen.getByText(format(HE['archive.summary'], { items: 2, files: 6 }))).toBeInTheDocument();
    const wedding = screen.getByRole('heading', { name: 'wedding_1954' }).closest('li')!;
    expect(within(wedding).getByText(HE['archive.hasText'])).toBeInTheDocument();
    expect(within(wedding).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['wedding_1954__1.jpg', 'wedding_1954__2.jpg']);
    const letter = screen.getByRole('heading', { name: 'letter' }).closest('li')!;
    expect(within(letter).getByText(HE['archive.noText'])).toBeInTheDocument();
    expect(screen.getByText(format(HE['archive.skipped'], { count: 1 }))).toBeInTheDocument();

    const warning = screen.getAllByRole('alert').find((el) => el.textContent?.includes('lost.txt'))!;
    expect(warning).toHaveTextContent(format(HE['archive.orphans'], { count: 1 }));
    const button = screen.getByRole('button', { name: format(HE['archive.upload'], { count: 2 }) });
    expect(button.parentElement).toBe(warning.parentElement);
    expect(button).toHaveAttribute('aria-describedby', warning.id);
    expect(button).toBeEnabled();
  });

  it('sends each item once, the .txt item with its text and skipAi, the other queued', async () => {
    const posted: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url === '/api/uploads/sign') { const p = `uploads/x/${Math.random()}`; return new Response(JSON.stringify({ ok: true, data: { path: p, token: 't', ...issueGrant(p) } })); }
      posted.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({ ok: true, data: { id: `id-${posted.length}`, title: 'x', receipt: 'r' } }), { status: 201 });
    }));
    renderFlow();
    pick(fileInputs()[1], [
      new File(['a'], 'a__1.jpg', { type: 'image/jpeg' }), new File(['Notes about a'], 'a.txt', { type: 'text/plain' }),
      new File(['b'], 'b.tif', { type: '' }),
    ]);
    fireEvent.click(screen.getByLabelText(HE['bulk.dateUnknown']));
    fireEvent.click(screen.getByLabelText(HE['bulk.creditNo']));
    fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(HE['bulk.consentLink']) }));
    fireEvent.click(screen.getByRole('button', { name: format(HE['archive.upload'], { count: 2 }) }));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[0]).toMatchObject({ name: 'a', skipAi: true, description: 'Notes about a', periodUnknown: true, creditRequired: false, consentVersion: '2026-09-07' });
    expect(posted[1]).toMatchObject({ name: 'b', skipAi: false });
    expect(posted[1].description).toBeUndefined();
    expect((posted[1].files as { mimeType: string }[])[0].mimeType).toBe('image/tiff');
    vi.unstubAllGlobals();
  });

  it('does not send until dating, copyright and consent are answered, and says so on each', () => {
    renderFlow();
    pick(fileInputs()[1], [new File(['a'], 'a.jpg', { type: 'image/jpeg' })]);
    fireEvent.click(screen.getByRole('button', { name: format(HE['archive.upload'], { count: 1 }) }));
    for (const key of ['bulk.err.period', 'bulk.err.credit', 'bulk.err.consent'] as const) {
      expect(screen.getByText(HE[key])).toHaveAttribute('role', 'alert');
    }
  });
});
