import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextRequest } from 'next/server';
import type { ReactNode } from 'react';
import { en, format, type MessageKey } from '@/lib/i18n/messages';
import he from '@/lib/i18n/locales/he.json';
import { MessagesProvider } from '@/lib/i18n/provider';
import { creditSegments, creditText } from '@/lib/files/credit-text';
import { facetOptions, hasPortalFilters, matchesFacets, matchesPerson, personHref, personKey, type FacetRow } from '@/lib/items/portal-facets';
import { batchDuplicates, earlierUploadHint, type ChecksumMatch } from '@/lib/files/duplicate-hint';

/**
 * Three of the four polish items: the rights notice (#7), linked contributor
 * and collector names (#13), and the contributor's duplicate notice (#17).
 * The fourth (the flaky focus test) has its own file, contributor-edit-focus.
 */

const HE = he as Record<string, string>;
const hebrew = (key: MessageKey, vars?: Record<string, string | number>) => format(HE[key] ?? en[key], vars);

// ── shared mocks for the record page and the sign route ────────────────────
const record = vi.hoisted(() => ({
  item: {} as Record<string, unknown>,
  /** Every item_files row holding the bytes, whoever uploaded them; the fake applies the query's filters. */
  admin: { rows: [] as unknown[], signed: { path: 'uploads/2026/11/x-a.jpg', token: 'tok' }, ignoreUploaderFilter: false },
  filters: [] as [string, unknown][],
  queried: 0,
  /** The signed-in profile for the sign route, or null for an anonymous upload. */
  session: null as null | { id: string; role: string },
}));
vi.mock('@/lib/supabase/server', () => ({ getCurrentVolunteer: async () => null, getCurrentProfile: async () => record.session }));
vi.mock('@/lib/items/public-tokens', () => ({ publicToken: () => 'test-token' }));
vi.mock('@/components/record-feedback', () => ({ RecordFeedback: () => null }));
vi.mock('@/components/record-edit-link', () => ({ RecordEditLink: () => null }));
vi.mock('@/components/reveal', () => ({ Reveal: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/community-mark', () => ({ CommunityMark: () => null }));
vi.mock('@/components/file-preview', () => ({ FilePreview: () => null }));
vi.mock('@/lib/vocabulary/queries', () => ({ listItemFamilies: async () => [] }));
vi.mock('@/lib/translate/render', () => ({ present: async () => ({ item: record.item, language: { code: 'he', label_native: 'עברית' }, translated: false, wanted: false }) }));
vi.mock('@/lib/i18n', () => ({ getMessages: async () => ({ language: { code: 'he' }, t: hebrew }) }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: () => ({
    storage: { from: () => ({ createSignedUploadUrl: async () => ({ data: record.admin.signed, error: null }) }) },
    from: () => {
      record.queried += 1;
      const filters: [string, unknown][] = [];
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => { filters.push([column, value]); record.filters.push([column, value]); return chain; },
        is: () => chain,
        order: () => chain,
        range: async () => {
          const checksum = filters.find(([c]) => c === 'checksum')?.[1];
          const uploader = filters.find(([c]) => c === 'items.uploaded_by')?.[1];
          const rows = (record.admin.rows as (ChecksumMatch & { checksum: string })[]).filter((r) =>
            r.checksum === checksum && (record.admin.ignoreUploaderFilter || r.items?.uploaded_by === uploader));
          return { data: rows, error: null };
        },
      };
      return chain;
    },
  }),
}));
vi.mock('@/lib/items/queries', async () => {
  const duplicates = await vi.importActual<typeof import('@/lib/items/duplicate-queries')>('@/lib/items/duplicate-queries');
  const { facetOptions: options } = await import('@/lib/items/portal-facets');
  return {
    findOwnDuplicate: duplicates.findOwnDuplicate,
    readRecordComments: async () => [], readRecordCorrections: async () => [], readApproverName: async () => null,
    getPublishedItem: async () => record.item, getRelatedValueCounts: async () => options([]), getKeywordLabels: async () => ({}),
  };
});
vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key-for-grants');

const { default: RecordPage } = await import('@/app/portal/[id]/page');
const { POST: sign } = await import('@/app/api/uploads/sign/route');
const { DuplicateNotice, withBatchDuplicates } = await import('@/components/duplicate-notice');
const { findOwnDuplicate } = await import('@/lib/items/duplicate-queries');

const baseItem = {
  id: 'rec-1', title: 'Purim', description: null, category: 'documents', community: null, period: null, origin_place: null,
  language: null, created_at: '2026-01-01', reviewed_at: null, file: null, files: [], keywords: [], fields: [],
  provenance: null, source_url: null, status: 'accepted', access: 'public',
};

// ── #7 rights notice ───────────────────────────────────────────────────────
describe('#7 the default credit no longer claims the Center owns the item', () => {
  it('names the archive without © when no rights holder is named', () => {
    expect(creditText(null, null)).toBe('Indian Jewish Heritage Center archive');
    expect(creditText(null, 'Sara')).toBe('Shared by Sara · Indian Jewish Heritage Center archive');
    for (const text of [creditText(null, null), creditText(null, 'Sara'), creditText('Levi', 'Sara')]) {
      expect(text).not.toMatch(/©\s*(Indian Jewish Heritage Center|IJHC)/);
    }
    expect(en).not.toHaveProperty('credit.centerCopyright');
  });

  it('credits a named collector with ©, and says so in Hebrew too', () => {
    expect(creditText('Levi', null)).toBe('© Levi collection · Indian Jewish Heritage Center archive');
    const hebrewText = creditText('לוי', null, hebrew);
    expect(hebrewText).toBe('© אוסף לוי · ארכיון מרכז מורשת יהדות הודו');
    expect(hebrewText).not.toContain('© מרכז');
  });

  it('keeps the parts apart so names can be linked', () => {
    expect(creditSegments('Levi', 'Sara').map((s) => [s.kind, s.name])).toEqual([['collector', 'Levi'], ['source', 'Sara'], ['archive', undefined]]);
  });

  it('shows the Terms of Use rule beside the credit on the record page', async () => {
    record.item = { ...baseItem, source: null, collector_name: null };
    render(await RecordPage({ params: Promise.resolve({ id: 'rec-1' }), searchParams: Promise.resolve({}) }));
    expect(screen.getByText(HE['credit.center'])).toBeInTheDocument();
    expect(screen.queryByText(/© מרכז מורשת/)).not.toBeInTheDocument();
    expect(screen.getByText(HE['credit.rights'], { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: HE['credit.terms'] })).toHaveAttribute('href', '/terms');
  });
});

// ── #13 linked names ───────────────────────────────────────────────────────
describe('#13 contributor and collector names link to their published items', () => {
  const row = (over: Partial<FacetRow>): FacetRow => ({
    id: 'r', created_at: '2026-01-01', reviewed_at: null, category: 'documents', community: null, keywords: [], period: null,
    origin_place: null, language: null, item_fields: [], item_files: [], item_families: [], source: null, collector_name: null, ...over,
  });

  it('matches whole names, ignoring case, spacing and Unicode composition, in either column', () => {
    expect(personKey('  Sara   LEVI ')).toBe('sara levi');
    expect(matchesPerson(row({ source: 'Sara Levi' }), 'sara  levi')).toBe(true);
    expect(matchesPerson(row({ collector_name: 'Sara Levi' }), 'Sara Levi')).toBe(true);
    expect(matchesPerson(row({ source: 'Sara Levine' }), 'Sara Levi')).toBe(false);
    expect(matchesPerson(row({ source: 'משפחת עזרא' }), ' משפחת  עזרא ')).toBe(true);
    // é composed vs decomposed
    expect(matchesPerson(row({ source: 'René' }), 'René')).toBe(true);
    expect(matchesPerson(row({ source: 'Sara' }), undefined)).toBe(true);
  });

  it('is a portal filter that combines with the others', () => {
    expect(hasPortalFilters({ person: 'Sara' })).toBe(true);
    expect(hasPortalFilters({ person: '  ' })).toBe(false);
    const rows = [row({ id: 'a', source: 'Sara', category: 'documents' }), row({ id: 'b', collector_name: 'sara', category: 'material_culture' }), row({ id: 'c', source: 'Ezra' })];
    expect(rows.filter((r) => matchesFacets(r, { person: 'Sara' })).map((r) => r.id)).toEqual(['a', 'b']);
    expect(rows.filter((r) => matchesFacets(r, { person: 'Sara', category: 'documents' })).map((r) => r.id)).toEqual(['a']);
    // It is not a facet: it never becomes a dropdown listing everyone's names.
    expect(Object.keys(facetOptions(rows))).not.toContain('person');
  });

  it('builds a URL-encoded link that reads back to the same Hebrew name', () => {
    const href = personHref('  משפחת   עזרא & בנים ');
    expect(href).toBe('/portal?person=%D7%9E%D7%A9%D7%A4%D7%97%D7%AA+%D7%A2%D7%96%D7%A8%D7%90+%26+%D7%91%D7%A0%D7%99%D7%9D');
    expect(new URL(href, 'https://archive.example').searchParams.get('person')).toBe('משפחת עזרא & בנים');
  });

  it('links the contributor field and both names in the credit line on the record page', async () => {
    record.item = { ...baseItem, source: 'שרה לוי', collector_name: 'Ezra family' };
    render(await RecordPage({ params: Promise.resolve({ id: 'rec-1' }), searchParams: Promise.resolve({}) }));
    const sara = personHref('שרה לוי');
    const ezra = personHref('Ezra family');
    const links = screen.getAllByRole('link').map((a) => [a.getAttribute('href'), a.getAttribute('aria-label')]);
    expect(links).toContainEqual([sara, hebrew('record.personLink', { name: 'שרה לוי' })]);
    expect(links).toContainEqual([ezra, hebrew('record.personLink', { name: 'Ezra family' })]);
    expect(links.filter(([href]) => href === sara)).toHaveLength(2); // contributor field and "shared by"
  });

  it('leaves "not recorded" unlinked', async () => {
    record.item = { ...baseItem, source: '  ', collector_name: null };
    render(await RecordPage({ params: Promise.resolve({ id: 'rec-1' }), searchParams: Promise.resolve({}) }));
    expect(screen.getAllByRole('link').some((a) => a.getAttribute('href')?.startsWith('/portal?person='))).toBe(false);
  });
});

// ── #17 duplicate notice ───────────────────────────────────────────────────
describe('#17 a contributor is warned only about their own double uploads', () => {
  const ME = 'expert-me';
  const OTHER = 'expert-other';
  const checksum = 'a'.repeat(64);
  const row = (item_id: string, uploaded_by: string | null, status = 'accepted', over: Partial<NonNullable<ChecksumMatch['items']>> = {}) =>
    ({ item_id, checksum, items: { uploaded_by, status, access: 'public', category: 'documents', deleted_at: null, ...over } });

  beforeEach(() => {
    record.filters = []; record.queried = 0; record.session = null; record.admin.ignoreUploaderFilter = false; record.admin.rows = [];
  });

  describe('the rule (pure)', () => {
    it('finds the uploader’s own earlier record, preferring a published one', () => {
      expect(earlierUploadHint([row('mine', ME, 'pending'), row('mine-pub', ME)], ME)).toEqual({ kind: 'earlier', itemId: 'mine-pub', published: true });
      expect(earlierUploadHint([row('mine', ME, 'pending')], ME)).toEqual({ kind: 'earlier', itemId: 'mine', published: false });
    });

    it('never reports someone else’s record, even if a query returned it', () => {
      expect(earlierUploadHint([row('theirs', OTHER)], ME)).toBeNull();
      expect(earlierUploadHint([row('anon', null)], ME)).toBeNull();
      expect(earlierUploadHint([row('theirs', OTHER), row('mine', ME, 'pending')], ME)).toEqual({ kind: 'earlier', itemId: 'mine', published: false });
    });

    it('has nothing to say without an uploader, or about a binned record', () => {
      expect(earlierUploadHint([row('mine', ME)], null)).toBeNull();
      expect(earlierUploadHint([row('mine', ME, 'accepted', { deleted_at: '2026-11-01' })], ME)).toBeNull();
    });

    it('flags the second and later copies of the same bytes in one upload', () => {
      const files = [{ id: 'a', checksum: 'x' }, { id: 'b', checksum: 'y' }, { id: 'c', checksum: 'x' }, { id: 'd', checksum: 'x' }, { id: 'e', checksum: null }, { id: 'f' }];
      expect([...batchDuplicates(files)]).toEqual(['c', 'd']);
    });
  });

  describe('POST /api/uploads/sign', () => {
    const post = (body: Record<string, unknown> = { fileName: 'a.jpg', mimeType: 'image/jpeg', byteSize: 100, checksum }) =>
      sign(new NextRequest('https://archive.example/api/uploads/sign', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.1.0.${Math.floor(Math.random() * 250)}` },
        body: JSON.stringify(body),
      }));

    it('warns a signed-in user re-uploading their own file, and still signs the upload', async () => {
      record.session = { id: ME, role: 'volunteer' };
      record.admin.rows = [row('mine', ME, 'pending')];
      const response = await post();
      expect(response.status).toBe(200);
      const { data } = await response.json();
      expect(data).toMatchObject({ path: 'uploads/2026/11/x-a.jpg', token: 'tok', duplicate: { kind: 'earlier', itemId: 'mine', published: false } });
      // The query itself is scoped to the uploader.
      expect(record.filters).toContainEqual(['items.uploaded_by', ME]);
    });

    it('says nothing to a signed-in user when only someone else uploaded the file', async () => {
      record.session = { id: ME, role: 'volunteer' };
      record.admin.rows = [row('theirs', OTHER), row('theirs-pending', OTHER, 'pending')];
      const text = await (await post()).text();
      expect(JSON.parse(text).data.duplicate).toBeNull();
      expect(text).not.toContain('theirs');
    });

    it('still says nothing if a broken query returned someone else’s rows', async () => {
      record.session = { id: ME, role: 'volunteer' };
      record.admin.ignoreUploaderFilter = true;
      record.admin.rows = [row('theirs', OTHER)];
      expect((await (await post()).json()).data.duplicate).toBeNull();
    });

    it('never queries the archive for an anonymous upload, even when the file is held', async () => {
      record.admin.rows = [row('theirs', OTHER), row('anon', null)];
      const { data } = await (await post()).json();
      expect(data.duplicate).toBeNull();
      expect(record.queried).toBe(0);
    });

    it('does not look anything up without a checksum', async () => {
      record.session = { id: ME, role: 'volunteer' };
      expect((await (await post({ fileName: 'a.jpg', mimeType: 'image/jpeg', byteSize: 100 })).json()).data.duplicate).toBeNull();
      expect(record.queried).toBe(0);
    });

    it('only looks up a well-formed SHA-256', async () => {
      expect(await findOwnDuplicate('not-a-hash', ME)).toBeNull();
      expect(await findOwnDuplicate(checksum, null)).toBeNull();
      expect(record.queried).toBe(0);
    });
  });

  describe('the notice on /upload', () => {
    const renderNotice = (files: Parameters<typeof DuplicateNotice>[0]['files']) => render(
      <MessagesProvider catalogue={{ ...en, ...HE }}><div dir="rtl"><DuplicateNotice files={files} /></div></MessagesProvider>,
    );

    it('says nothing when nothing was uploaded twice', () => {
      const { container } = renderNotice(withBatchDuplicates([{ id: 'a', fileName: 'a.jpg', checksum: 'x' }, { id: 'b', fileName: 'b.jpg', checksum: 'y' }]));
      expect(container.querySelector('section')).toBeNull();
    });

    it('flags the same file added twice in one upload, on the second copy', () => {
      renderNotice(withBatchDuplicates([{ id: 'a', fileName: 'ketuba.jpg', checksum: 'x' }, { id: 'b', fileName: 'ketuba (1).jpg', checksum: 'x' }]));
      expect(screen.getByRole('status')).toHaveTextContent(HE['upload.duplicate.heading']);
      expect(screen.getByText(/ketuba \(1\)\.jpg/)).toHaveTextContent(HE['upload.duplicate.batch'].replace('{name}', '').trim());
      expect(screen.queryByText(/^⁨ketuba\.jpg/)).toBeNull();
      expect(screen.queryByRole('link')).toBeNull();
      expect(screen.queryByRole('button')).toBeNull(); // never blocks
    });

    it('says "you already uploaded this" and links the earlier record — public page or review page', () => {
      renderNotice([
        { id: 'a', fileName: 'scan.jpg', duplicate: { kind: 'earlier', itemId: 'pub', published: true } },
        { id: 'b', fileName: 'flyer.jpg', duplicate: { kind: 'earlier', itemId: 'queued', published: false } },
      ]);
      expect(screen.getByText(/scan\.jpg/)).toHaveTextContent(HE['upload.duplicate.earlier'].replace('{name}', '').trim());
      expect(screen.getAllByRole('link', { name: HE['upload.duplicate.view'] }).map((a) => a.getAttribute('href'))).toEqual(['/portal/pub', '/review/queued']);
      expect(screen.getByText(HE['upload.duplicate.proceed'])).toBeInTheDocument();
    });

    it('keeps the server’s "earlier" hint over a batch repeat', () => {
      const files = withBatchDuplicates([
        { id: 'a', fileName: 'a.jpg', checksum: 'x' },
        { id: 'b', fileName: 'a.jpg', checksum: 'x', duplicate: { kind: 'earlier', itemId: 'mine', published: true } },
      ]);
      expect(files.map((f) => f.duplicate)).toEqual([undefined, { kind: 'earlier', itemId: 'mine', published: true }]);
    });

    it('no longer says anything about the archive holding the file', () => {
      for (const catalogue of [en as Record<string, string>, HE]) {
        const text = Object.entries(catalogue).filter(([key]) => key.startsWith('upload.duplicate.')).map(([, v]) => v).join(' ');
        expect(text).not.toMatch(/already holds|already in the archive|כבר נמצא בארכיון/);
      }
    });
  });
});
