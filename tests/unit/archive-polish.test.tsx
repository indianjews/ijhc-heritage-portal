import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextRequest } from 'next/server';
import type { ReactNode } from 'react';
import { en, format, type MessageKey } from '@/lib/i18n/messages';
import he from '@/lib/i18n/locales/he.json';
import { MessagesProvider } from '@/lib/i18n/provider';
import { creditSegments, creditText } from '@/lib/files/credit-text';
import { facetOptions, hasPortalFilters, matchesFacets, matchesPerson, personHref, personKey, type FacetRow } from '@/lib/items/portal-facets';
import { duplicateHint, type ChecksumMatch } from '@/lib/files/duplicate-hint';

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
  admin: { rows: [] as unknown[], signed: { path: 'uploads/2026/11/x-a.jpg', token: 'tok' } },
  checksums: [] as string[],
}));
vi.mock('@/lib/supabase/server', () => ({ getCurrentVolunteer: async () => null }));
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
      const chain = {
        select: () => chain,
        eq: (_c: string, value: string) => { record.checksums.push(value); return chain; },
        order: () => chain,
        range: async () => ({ data: record.admin.rows, error: null }),
      };
      return chain;
    },
  }),
}));
vi.mock('@/lib/items/queries', async () => {
  const duplicates = await vi.importActual<typeof import('@/lib/items/duplicate-queries')>('@/lib/items/duplicate-queries');
  const { facetOptions: options } = await import('@/lib/items/portal-facets');
  return {
    findDuplicateHint: duplicates.findDuplicateHint,
    readRecordComments: async () => [], readRecordCorrections: async () => [], readApproverName: async () => null,
    getPublishedItem: async () => record.item, getRelatedValueCounts: async () => options([]), getKeywordLabels: async () => ({}),
  };
});
vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key-for-grants');

const { default: RecordPage } = await import('@/app/portal/[id]/page');
const { POST: sign } = await import('@/app/api/uploads/sign/route');
const { DuplicateNotice } = await import('@/components/duplicate-notice');
const { findDuplicateHint } = await import('@/lib/items/duplicate-queries');

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
describe('#17 contributors are told about a duplicate file, without leaking unpublished records', () => {
  const match = (item_id: string, status: string, over: Partial<NonNullable<ChecksumMatch['items']>> = {}): ChecksumMatch =>
    ({ item_id, items: { status, access: 'public', category: 'documents', deleted_at: null, ...over } });

  it('identifies only a record published to everyone', () => {
    expect(duplicateHint([])).toBeNull();
    expect(duplicateHint([match('pub', 'accepted')])).toEqual({ publishedId: 'pub' });
    expect(duplicateHint([match('p', 'pending'), match('pub', 'accepted')])).toEqual({ publishedId: 'pub' });
  });

  it.each([
    ['pending', match('secret', 'pending')],
    ['rejected', match('secret', 'rejected')],
    ['shadow gallery', match('secret', 'shadow_gallery')],
    ['restricted', match('secret', 'accepted', { access: 'research' })],
    ['uncatalogued', match('secret', 'accepted', { category: null })],
  ])('says only "exists" for a %s match, never its id', (_label, row) => {
    const hint = duplicateHint([row]);
    expect(hint).toEqual({ publishedId: null });
    expect(JSON.stringify(hint)).not.toContain('secret');
  });

  it('ignores records in the bin', () => {
    expect(duplicateHint([match('binned', 'accepted', { deleted_at: '2026-11-01' })])).toBeNull();
  });

  it('only looks up a well-formed SHA-256', async () => {
    record.checksums = [];
    expect(await findDuplicateHint('not-a-hash')).toBeNull();
    expect(record.checksums).toEqual([]);
  });

  describe('POST /api/uploads/sign', () => {
    const checksum = 'a'.repeat(64);
    const post = (body: Record<string, unknown>) => sign(new NextRequest('https://archive.example/api/uploads/sign', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.1.0.${Math.floor(Math.random() * 250)}` },
      body: JSON.stringify(body),
    }));
    beforeEach(() => { record.checksums = []; });

    it('still signs the upload, and adds the hint — non-blocking', async () => {
      record.admin.rows = [match('pub', 'accepted')];
      const response = await post({ fileName: 'a.jpg', mimeType: 'image/jpeg', byteSize: 100, checksum });
      expect(response.status).toBe(200);
      const { data } = await response.json();
      expect(data).toMatchObject({ path: 'uploads/2026/11/x-a.jpg', token: 'tok', duplicate: { publishedId: 'pub' } });
      expect(record.checksums).toEqual([checksum]);
    });

    it('returns nothing identifying for an unpublished match', async () => {
      record.admin.rows = [match('pending-record-id', 'pending')];
      const response = await post({ fileName: 'a.jpg', mimeType: 'image/jpeg', byteSize: 100, checksum });
      const text = await response.text();
      expect(JSON.parse(text).data.duplicate).toEqual({ publishedId: null });
      expect(text).not.toContain('pending-record-id');
      expect(text).not.toContain('pending');
    });

    it('returns null when nothing matches, or when no checksum was sent', async () => {
      record.admin.rows = [];
      expect((await (await post({ fileName: 'a.jpg', mimeType: 'image/jpeg', byteSize: 100, checksum })).json()).data.duplicate).toBeNull();
      expect((await (await post({ fileName: 'a.jpg', mimeType: 'image/jpeg', byteSize: 100 })).json()).data.duplicate).toBeNull();
    });
  });

  describe('the notice on /upload', () => {
    const renderNotice = (files: Parameters<typeof DuplicateNotice>[0]['files']) => render(
      <MessagesProvider catalogue={{ ...en, ...HE }}><div dir="rtl"><DuplicateNotice files={files} /></div></MessagesProvider>,
    );

    it('says nothing when there is no duplicate', () => {
      const { container } = renderNotice([{ fileName: 'a.jpg', duplicate: null }, { fileName: 'b.jpg' }]);
      expect(container.querySelector('section')).toBeNull();
    });

    it('names the file, links a published match, and says the contributor may still send it', () => {
      renderNotice([{ fileName: 'ketuba.jpg', duplicate: { publishedId: 'pub' } }]);
      expect(screen.getByRole('status')).toHaveTextContent(HE['upload.duplicate.heading']);
      expect(screen.getByText(/ketuba\.jpg/)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: HE['upload.duplicate.view'] })).toHaveAttribute('href', '/portal/pub');
      expect(screen.getByText(HE['upload.duplicate.proceed'])).toBeInTheDocument();
      expect(screen.queryByRole('button')).toBeNull(); // nothing to dismiss or confirm: it never blocks
    });

    it('offers no link for an unpublished match', () => {
      renderNotice([{ fileName: 'scan.jpg', duplicate: { publishedId: null } }]);
      expect(screen.getByText(/scan\.jpg/)).toBeInTheDocument();
      expect(screen.queryByRole('link')).toBeNull();
    });
  });
});
