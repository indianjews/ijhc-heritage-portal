import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import type { ReactNode } from 'react';
import { en, format, type MessageKey } from '@/lib/i18n/messages';
import he from '@/lib/i18n/locales/he.json';
import { MessagesProvider } from '@/lib/i18n/provider';
import { PublicInput, feedbackKind } from '@/lib/items/public-input';
import { NONE, filterQueue, queueOptions } from '@/lib/items/review-filter';
import { searchWords } from '@/lib/items/portal-facets';
import { isPublicMediaPath } from '@/components/public-media';
import { archiveUserAgent } from '@/lib/links/policy';
import type { Profile } from '@/lib/types';

/**
 * The expert-and-search polish batch: corrections link (#6), private problem
 * reports (#5/#6), review-queue search (#9), quoted portal search (#15,
 * phase tests live in phase1-queries), home-page media protection (#20) and
 * the old host (item 2).
 */

const HE = he as Record<string, string>;
const english = (key: MessageKey, vars?: Record<string, string | number>) => format(en[key], vars);

const m = vi.hoisted(() => ({
  pathname: '/',
  volunteer: null as null | { id: string; role: string },
  feedback: vi.fn<(input: Record<string, unknown>) => Promise<boolean>>(async () => true),
  notify: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  decide: vi.fn<(id: string, status: string) => Promise<boolean>>(async () => true),
  reportsRead: vi.fn(async () => [] as unknown[]),
  correctionsRead: vi.fn(async () => [] as unknown[]),
  item: { id: 'rec-1', title: 'Purim', category: 'documents', status: 'accepted', access: 'public' } as Record<string, unknown>,
}));
vi.mock('next/navigation', () => ({ usePathname: () => m.pathname, useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), redirect: (to: string) => { throw new Error(`redirect:${to}`); } }));
vi.mock('next/server', async (original) => ({ ...await original<typeof import('next/server')>(), after: (job: () => Promise<void>) => { void job(); } }));
vi.mock('@/lib/supabase/server', () => ({ getCurrentVolunteer: async () => m.volunteer, getCurrentProfile: async () => m.volunteer }));
vi.mock('@/lib/i18n', () => ({ getMessages: async () => ({ t: english, language: { code: 'en' } }) }));
vi.mock('@/lib/items/public-tokens', () => ({ verifyPublicToken: () => true, publicToken: () => 'objection-token' }));
vi.mock('@/lib/items/mutations', () => ({ createPublicFeedback: m.feedback, decideRecordReport: m.decide }));
vi.mock('@/lib/mail/record-feedback', () => ({ notifyRecordFeedback: m.notify }));
vi.mock('@/lib/items/queries', () => ({
  getPublishedItem: async () => m.item,
  readRecordReports: m.reportsRead,
  readRecordCorrections: m.correctionsRead,
}));
vi.mock('@/components/correction-decision', () => ({ CorrectionDecision: () => null }));

const { ArchiveNav } = await import('@/components/site-nav');
const { POST: feedback } = await import('@/app/api/records/[id]/feedback/route');
const { POST: decideReport } = await import('@/app/api/reports/[id]/decision/route');
const { default: CorrectionsPage } = await import('@/app/review/corrections/page');
const { RecordFeedback } = await import('@/components/record-feedback');
const { ReviewQueue } = await import('@/components/review-queue');

const ITEM_ID = '0b8e6a9c-0000-4000-8000-000000000001';
const REPORT_ID = '0b8e6a9c-0000-4000-8000-0000000000aa';
const person = (role: Profile['role']) => ({ id: role, email: `${role}@example.org`, role } as Profile);
function inMessages(node: ReactNode, catalogue: Record<string, string> = en) {
  return render(<MessagesProvider catalogue={catalogue}>{node}</MessagesProvider>);
}

beforeEach(() => {
  m.pathname = '/'; m.volunteer = null;
  m.feedback.mockClear(); m.notify.mockClear(); m.decide.mockClear(); m.reportsRead.mockClear(); m.correctionsRead.mockClear();
});

// ── Task 1 ────────────────────────────────────────────────────────────────
describe('#6 /review/corrections is easy to find', () => {
  it.each(['volunteer', 'admin'] as const)('is in the Archive menu for a %s, after Bulk upload', (role) => {
    inMessages(<ArchiveNav profile={person(role)} queueCount={0} layout="bar" />);
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/review/corrections');
    expect(hrefs.indexOf('/review/corrections')).toBe(hrefs.indexOf('/review/bulk-upload') + 1);
    expect(screen.getByRole('link', { name: en['nav.corrections'] })).toHaveAttribute('href', '/review/corrections');
  });

  it.each([['anonymous', null], ['pending', person('pending')]] as const)('is not shown to a %s visitor', (_label, profile) => {
    const { container } = inMessages(<ArchiveNav profile={profile} queueCount={0} layout="panel" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is the only lit link on its own page', () => {
    m.pathname = '/review/corrections';
    inMessages(<ArchiveNav profile={person('volunteer')} queueCount={0} layout="bar" />);
    expect(screen.getByRole('link', { name: en['nav.corrections'] })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: en['nav.review'] })).not.toHaveAttribute('aria-current');
  });

  it('has a button on /review next to Bulk upload, for experts only', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/app/review/page.tsx'), 'utf8');
    const block = source.slice(source.indexOf('{volunteer && ('), source.indexOf('</header>'));
    expect(block).toContain('href="/review/corrections"');
    expect(block).toContain('href="/review/bulk-upload"');
  });
});

// ── Task 2 ────────────────────────────────────────────────────────────────
describe('#5/#6 private problem reports', () => {
  const post = (body: Record<string, unknown>) => feedback(new NextRequest(`https://archive.example/api/records/${ITEM_ID}/feedback`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.2.0.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify({ token: 't', anonymous: true, website: '', ...body }),
  }), { params: Promise.resolve({ id: ITEM_ID }) });

  it('is its own kind of feedback', () => {
    expect(feedbackKind({ reason: 'living_person' })).toBe('report');
    expect(feedbackKind({ values: {} })).toBe('correction');
    expect(feedbackKind({})).toBe('comment');
  });

  it('accepts only the listed reasons, needs details for "other", and is never also a correction', () => {
    const base = { anonymous: true, token: 't' };
    expect(PublicInput.safeParse({ ...base, reason: 'mistake' }).success).toBe(true);
    expect(PublicInput.safeParse({ ...base, reason: 'spam' }).success).toBe(false);
    expect(PublicInput.safeParse({ ...base, reason: 'other' }).success).toBe(false);
    expect(PublicInput.safeParse({ ...base, reason: 'other', body: 'Wrong family' }).success).toBe(true);
    expect(PublicInput.safeParse({ ...base, reason: 'mistake', values: { title: 'x' } }).success).toBe(false);
  });

  it('stores a report as a report (not a comment) and notifies as a report', async () => {
    const response = await post({ reason: 'living_person', body: 'My mother is in this photo.' });
    expect(response.status).toBe(201);
    expect(m.feedback).toHaveBeenCalledWith(expect.objectContaining({ kind: 'report', reason: 'living_person', itemId: ITEM_ID, body: 'My mother is in this photo.' }));
    await vi.waitFor(() => expect(m.notify).toHaveBeenCalled());
    const [, kind, , , , , reason] = m.notify.mock.calls[0];
    expect([kind, reason]).toEqual(['report', 'living_person']);
  });

  it('accepts a report with only a reason, while a comment still needs words', async () => {
    expect((await post({ reason: 'mistake' })).status).toBe(201);
    expect((await post({})).status).toBe(400);
  });

  it('is never rendered on the public record: the form says it is private, and no report is ever read there', () => {
    inMessages(<RecordFeedback itemId={ITEM_ID} token="t" fields={[]} comments={[{ id: 'c', item_id: ITEM_ID, author_name: 'Sara', anonymous: false, body: 'A public comment', created_at: '2026-11-01', hidden_at: null }] as never} expert={false} />);
    expect(screen.getByText('A public comment')).toBeInTheDocument();
    expect(screen.getByText(en['report.summary'], { selector: 'summary' })).toBeInTheDocument();
    expect(screen.getByText(en['report.hint'])).toBeInTheDocument();
    expect(m.reportsRead).not.toHaveBeenCalled();
    // The record page module does not even import the report reader.
    const page = fs.readFileSync(path.join(process.cwd(), 'src/app/portal/[id]/page.tsx'), 'utf8');
    expect(page).not.toMatch(/readRecordReports|record_reports/);
  });

  it('sends the reason the visitor picked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { saved: true } }))));
    const { container } = inMessages(<RecordFeedback itemId={ITEM_ID} token="t" fields={[]} comments={[]} expert={false} />);
    const form = [...container.querySelectorAll('form')].find((f) => f.querySelector('select[name=reason]'))!;
    fireEvent.click(within(form).getByLabelText(en['public.anonymous']));
    fireEvent.change(within(form).getByLabelText(en['report.reason']), { target: { value: 'rights' } });
    fireEvent.submit(form);
    await screen.findByText(en['report.sent']);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ reason: 'rights', anonymous: true });
    expect(body).not.toHaveProperty('values');
    vi.unstubAllGlobals();
  });

  describe('/review/corrections', () => {
    const report = { id: REPORT_ID, item_id: ITEM_ID, reason: 'living_person', body: 'Please remove my aunt', reporter_name: 'Dina', reporter_email: 'dina@example.org', anonymous: false, created_at: '2026-11-20T00:00:00Z', record_title: 'Purim 1962' };

    it('sends anyone who is not an expert away', async () => {
      await expect(CorrectionsPage()).rejects.toThrow('redirect:/login');
      expect(m.reportsRead).not.toHaveBeenCalled();
    });

    it('lists open reports for an expert, with reason, words and contact', async () => {
      m.volunteer = { id: 'e', role: 'volunteer' };
      m.reportsRead.mockResolvedValueOnce([report]);
      inMessages(await CorrectionsPage());
      const card = screen.getByRole('heading', { name: 'Purim 1962' }).closest('article')!;
      expect(within(card).getByText(`${en['report.reason']}: ${en['report.reason.living_person']}`)).toBeInTheDocument();
      expect(within(card).getByText('Please remove my aunt')).toBeInTheDocument();
      expect(within(card).getByRole('link', { name: 'dina@example.org' })).toHaveAttribute('href', 'mailto:dina@example.org');
      expect(within(card).getByRole('button', { name: en['report.resolve'] })).toBeInTheDocument();
      expect(within(card).getByRole('button', { name: en['report.dismiss'] })).toBeInTheDocument();
    });

    it('decides a report only for an expert', async () => {
      const call = (body: unknown) => decideReport(new NextRequest(`https://archive.example/api/reports/${REPORT_ID}/decision`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }), { params: Promise.resolve({ id: REPORT_ID }) });
      expect((await call({ status: 'resolved' })).status).toBe(403);
      expect(m.decide).not.toHaveBeenCalled();
      m.volunteer = { id: 'e', role: 'volunteer' };
      expect((await call({ status: 'deleted' })).status).toBe(400);
      expect((await call({ status: 'dismissed' })).status).toBe(200);
      expect(m.decide).toHaveBeenCalledWith(REPORT_ID, 'dismissed');
    });
  });

  it('keeps the table private in the migration: no anon grant, experts only', () => {
    const sql = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/0042_a_problem_can_be_reported_privately.sql'), 'utf8');
    expect(sql).toMatch(/revoke all on public\.record_reports from anon, authenticated/);
    expect(sql).not.toMatch(/grant [^;]* to anon/);
    expect(sql).not.toMatch(/create view/i);
    expect(sql).toMatch(/using \(public\.is_volunteer\(\)\)/);
  });
});

// ── Task 3 ────────────────────────────────────────────────────────────────
describe('#9 search and filters in the review queue', () => {
  const items = [
    { id: '1', title: 'Ketubah from Cochin', description: null, contributor_description: null, source: 'Sara Levi', collector_name: null, community: 'cochin', category: null, created_at: '2026-01-01' },
    { id: '2', title: 'Purim party', description: 'Magen David synagogue, Mumbai', contributor_description: null, source: null, collector_name: 'Ezra family', community: 'baghdadi', category: 'documents', created_at: '2026-01-02' },
    { id: '3', title: 'Wedding photograph', description: null, contributor_description: 'כתובה של סבתא', source: null, collector_name: null, community: 'cochin', category: 'material_culture', created_at: '2026-01-03' },
  ];
  const label = (value: string) => english(`community.${value}` as MessageKey);

  it('matches title, description, notes, names and community, keeping oldest-first order', () => {
    expect(filterQueue(items, { text: 'ketubah' }).map((i) => i.id)).toEqual(['1']);
    expect(filterQueue(items, { text: 'mumbai' }).map((i) => i.id)).toEqual(['2']);
    expect(filterQueue(items, { text: 'כתובה' }).map((i) => i.id)).toEqual(['3']);
    expect(filterQueue(items, { text: 'ezra' }).map((i) => i.id)).toEqual(['2']);
    expect(filterQueue(items, { text: 'sara  LEVI' }).map((i) => i.id)).toEqual(['1']);
    expect(filterQueue(items, { text: 'cochin' }).map((i) => i.id)).toEqual(['1', '3']);
    expect(filterQueue(items, { text: label('baghdadi') }, label).map((i) => i.id)).toEqual(['2']);
  });

  it('filters by community and category, including "not yet catalogued"', () => {
    expect(filterQueue(items, { community: 'cochin' }).map((i) => i.id)).toEqual(['1', '3']);
    expect(filterQueue(items, { community: 'cochin', category: 'material_culture' }).map((i) => i.id)).toEqual(['3']);
    expect(filterQueue(items, { category: NONE }).map((i) => i.id)).toEqual(['1']);
    expect(filterQueue(items, {}).map((i) => i.id)).toEqual(['1', '2', '3']);
  });

  it('offers only values present in the queue', () => {
    expect(queueOptions(items)).toEqual({ communities: ['baghdadi', 'cochin'], categories: ['documents', 'material_culture'], uncategorised: true });
  });

  it('filters the rendered queue, keeps the view toggle, and clears the selection', () => {
    const queued = items.map((i) => ({ ...i, file: null, analysis: null, contributor_keywords: [], keywords: [], status: 'pending' }));
    inMessages(<ReviewQueue items={queued as never} />, { ...en, ...HE });
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    fireEvent.click(screen.getAllByRole('checkbox', { name: HE['review3.select'] })[0]);
    fireEvent.change(screen.getByLabelText(HE['filters.community']), { target: { value: 'cochin' } });
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([expect.stringContaining('Ketubah'), expect.stringContaining('Wedding')]);
    expect(screen.getByText(format(HE['review3.filterShowing'], { shown: 2, total: 3 }))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: format(HE['review3.approveSelected'], { count: 0 }) })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(HE['review3.filterText']), { target: { value: 'nothing-like-this' } });
    expect(screen.getByText(HE['review3.filterNone'])).toBeInTheDocument();
    expect(screen.getByRole('button', { name: HE['review3.grid'] })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: HE['review3.list'] })).toBeInTheDocument();
  });
});

// ── Task 4 ────────────────────────────────────────────────────────────────
describe('#15 quotation marks in portal search', () => {
  it.each([
    ['"Ezra synagogue"', ['ezra synagogue']],
    ['“Ezra   synagogue”', ['ezra synagogue']],
    ['"Ezra synagogue" Pune', ['ezra synagogue', 'pune']],
    ['Pune "Ezra synagogue"', ['ezra synagogue', 'pune']],
    ['Ezra synagogue', ['ezra', 'synagogue']],
    ['"Ezra synagogue', ['ezra', 'synagogue']],
    ['Ezra"', ['ezra']],
    ['ד"ר כהן', ['ד"ר', 'כהן']],
    ['"בית הכנסת" ביה"כ', ['בית הכנסת', 'ביה"כ']],
    ['״מגן דוד״', ['מגן דוד']],
    ['«Kolkata»', ['kolkata']],
    ['""', []],
    ['   ', []],
  ])('%j → %j', (query, terms) => {
    expect(searchWords(query)).toEqual(terms);
  });
});

// ── Task 5 ────────────────────────────────────────────────────────────────
describe('#20 home-page media protection, and no old host in runtime code', () => {
  it('protects public media on the home page as well as the portal', () => {
    for (const p of ['/', '/portal', '/portal/abc']) expect(isPublicMediaPath(p)).toBe(true);
    for (const p of ['/upload', '/review', '/review/abc', '/portaled', null]) expect(isPublicMediaPath(p)).toBe(false);
  });

  it('fetches links as the Center, never as the old personal deployment', () => {
    expect(archiveUserAgent(undefined)).toBe('IJHC-Heritage-Archive/1.0 (+https://archive.indianjews.org)');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) {
          // Comments may name the old host as history; code may not.
          const code = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
          if (code.includes('heritage-portal-snowy')) offenders.push(file);
        }
      }
    };
    walk(path.join(process.cwd(), 'src'));
    expect(offenders).toEqual([]);
  });
});
