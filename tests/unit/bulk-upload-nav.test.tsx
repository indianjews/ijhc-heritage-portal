import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '@/lib/i18n/messages';
import he from '@/lib/i18n/locales/he.json';
import { MessagesProvider } from '@/lib/i18n/provider';
import type { Profile } from '@/lib/types';

/**
 * The "Bulk upload" link in the archive menu: in the bar and in the phone
 * panel, for approved content experts and administrators only.
 */

const nav = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

const { ArchiveNav, archiveLinkCurrent } = await import('@/components/site-nav');

const HE = he as Record<string, string>;
const person = (role: Profile['role']) => ({ id: role, email: `${role}@example.org`, role } as Profile);
const layouts = ['bar', 'panel'] as const;

function renderNav(profile: Profile | null, layout: 'bar' | 'panel', catalogue: Record<string, string> = en) {
  return render(
    <MessagesProvider catalogue={catalogue}>
      <ArchiveNav profile={profile} queueCount={3} layout={layout} />
    </MessagesProvider>,
  );
}

beforeEach(() => { nav.pathname = '/'; });

describe('who sees the Bulk upload link', () => {
  for (const layout of layouts) {
    it.each(['volunteer', 'admin'] as const)(`shows it to a %s (${layout})`, (role) => {
      renderNav(person(role), layout);
      const link = screen.getByRole('link', { name: en['nav.bulkUpload'] });
      expect(link).toHaveAttribute('href', '/review/bulk-upload');
      // Beside the other expert links, right after Review.
      const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
      expect(hrefs.indexOf('/review/bulk-upload')).toBe(hrefs.indexOf('/review') + 1);
    });

    it(`hides it from an anonymous visitor (${layout})`, () => {
      const { container } = renderNav(null, layout);
      expect(container).toBeEmptyDOMElement();
      expect(screen.queryByRole('link', { name: en['nav.bulkUpload'] })).not.toBeInTheDocument();
    });

    it(`hides it from a pending account (${layout})`, () => {
      const { container } = renderNav(person('pending'), layout);
      expect(container).toBeEmptyDOMElement();
      expect(screen.queryByRole('link', { name: en['nav.bulkUpload'] })).not.toBeInTheDocument();
    });
  }
});

describe('active state', () => {
  it('on /review/bulk-upload only Bulk upload is the current page', () => {
    nav.pathname = '/review/bulk-upload';
    renderNav(person('volunteer'), 'bar');
    expect(screen.getByRole('link', { name: en['nav.bulkUpload'] })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: new RegExp(en['nav.review']) })).not.toHaveAttribute('aria-current');
  });

  it('on the queue and on a record in review, Review stays current', () => {
    for (const path of ['/review', '/review/0b8e6a9c-0000-4000-8000-000000000000', '/review/corrections']) {
      expect(archiveLinkCurrent('/review', path)).toBe(true);
      expect(archiveLinkCurrent('/review/bulk-upload', path)).toBe(false);
    }
    expect(archiveLinkCurrent('/review', '/reviewer')).toBe(false);
    expect(archiveLinkCurrent('/manage/vocabulary', '/manage/vocabulary')).toBe(true);
  });
});

describe('in Hebrew', () => {
  it('uses the page’s own name and keeps the logical layout', () => {
    renderNav(person('admin'), 'panel', { ...en, ...HE });
    const link = screen.getByRole('link', { name: HE['nav.bulkUpload'] });
    expect(HE['nav.bulkUpload']).toBe(HE['bulk.title']);
    expect(link.className).toMatch(/h-12/);
    expect(link.className).not.toMatch(/\b(ml|mr|pl|pr)-\d|text-left|text-right/);
  });
});
