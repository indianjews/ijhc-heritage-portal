import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '@/lib/i18n/messages';
import he from '@/lib/i18n/locales/he.json';
import { MessagesProvider } from '@/lib/i18n/provider';

/**
 * The bulk-upload screen, in Hebrew and right-to-left at phone width, plus
 * the page's render gate. No network: fetch is stubbed and fails loudly if
 * anything tries to send.
 */

const gate = vi.hoisted(() => ({ volunteer: vi.fn(), profile: vi.fn(), redirect: vi.fn((to: string) => { throw new Error(`redirect:${to}`); }) }));
vi.mock('@/lib/supabase/server', () => ({ getCurrentVolunteer: gate.volunteer, getCurrentProfile: gate.profile }));
vi.mock('next/navigation', () => ({ redirect: gate.redirect, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/lib/i18n', () => ({ getMessages: async () => ({ t: (key: keyof typeof en) => en[key] ?? key, language: { code: 'en' } }) }));
vi.mock('@/lib/files/upload', () => ({ uploadSignedFile: vi.fn() }));

const { BulkUploadFlow } = await import('@/components/bulk-upload-flow');
const { default: BulkUploadPage } = await import('@/app/review/bulk-upload/page');
const { AwaitingApproval } = await import('@/components/awaiting-approval');

const HE = he as Record<string, string>;

function renderHebrew() {
  return render(
    <MessagesProvider catalogue={HE}>
      <div dir="rtl" lang="he" style={{ width: 375 }}>
        <BulkUploadFlow consentVersion="2026-09-07" />
      </div>
    </MessagesProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in this test'); }));
  gate.volunteer.mockReset(); gate.profile.mockReset(); gate.redirect.mockClear();
});

describe('the bulk-upload screen in Hebrew', () => {
  it('shows one item, in the required field order, with Hebrew labels', () => {
    renderHebrew();
    const card = screen.getByRole('article');
    expect(within(card).getByRole('heading', { name: /פריט 1/ })).toBeInTheDocument();
    const legends = within(card).getAllByText((_, el) => el?.tagName === 'LEGEND').map((el) => el.textContent?.replace('*', '').trim());
    expect(legends).toEqual([HE['bulk.media'], HE['bulk.dating'], HE['bulk.credit']]);
    // Notes sit between media and dating.
    const order = [HE['bulk.media'], HE['bulk.description'], HE['bulk.dating'], HE['bulk.credit']]
      .map((text) => card.innerHTML.indexOf(text));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(within(card).getByLabelText(HE['bulk.dateUnknown'])).toBeInTheDocument();
    // No copyright answer is preselected.
    const radios = within(card).getAllByRole('radio') as HTMLInputElement[];
    expect(radios).toHaveLength(2);
    expect(radios.every((r) => !r.checked)).toBe(true);
  });

  it('uses logical, RTL-safe layout and 44px controls', () => {
    const { container } = renderHebrew();
    const html = container.innerHTML;
    expect(html).not.toMatch(/\b(ml|mr|pl|pr)-\d|text-left|text-right/);
    for (const button of screen.getAllByRole('button')) expect(button.className).toMatch(/h-11|min-h-11|h-9/);
    // Free text follows its own direction; URLs and years stay left-to-right.
    expect(screen.getByLabelText(HE['bulk.description'])).toHaveAttribute('dir', 'auto');
    expect(screen.getByLabelText(HE['bulk.youtube'])).toHaveAttribute('dir', 'ltr');
  });

  it('offers exactly the accepted images, PDFs and videos in the file picker', () => {
    const { container } = renderHebrew();
    const picker = container.querySelector('input[type=file]')!;
    expect(picker.getAttribute('accept')!.split(',')).toEqual([
      'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/tiff', 'application/pdf', 'video/mp4', 'video/webm', 'video/quicktime',
    ]);
    expect(picker).toHaveAttribute('multiple');
    expect(screen.getByText(HE['bulk.chooseFiles'])).toBeInTheDocument();
  });

  it('lists a picked PDF and refuses an audio file with a Hebrew message', () => {
    const { container } = renderHebrew();
    const picker = container.querySelector('input[type=file]')!;
    const pdf = new File([new Uint8Array(10)], 'תוכנייה.pdf', { type: 'application/pdf' });
    const audio = new File([new Uint8Array(10)], 'שיר.mp3', { type: 'audio/mpeg' });
    fireEvent.change(picker, { target: { files: [pdf, audio] } });
    expect(screen.getByText('תוכנייה.pdf')).toBeInTheDocument();
    expect(screen.queryByText('שיר.mp3')).not.toBeInTheDocument();
    expect(screen.getByText(HE['bulk.err.fileType'].replace('{name}', 'שיר.mp3'))).toBeInTheDocument();
  });

  it('refuses to send until media, dating and copyright are answered, and says why in Hebrew', () => {
    renderHebrew();
    fireEvent.click(screen.getByRole('button', { name: /שליחת הכול/ }));
    expect(screen.getByText(HE['bulk.err.media'])).toBeInTheDocument();
    expect(screen.getByText(HE['bulk.err.period'])).toBeInTheDocument();
    expect(screen.getByText(HE['bulk.err.credit'])).toBeInTheDocument();
    expect(screen.getByText(HE['bulk.err.consent'])).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('"Date unknown" satisfies the dating rule and disables the year box', () => {
    renderHebrew();
    fireEvent.click(screen.getByLabelText(HE['bulk.dateUnknown']));
    expect(screen.getByLabelText(HE['bulk.datingHint'])).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /שליחת הכול/ }));
    expect(screen.queryByText(HE['bulk.err.period'])).not.toBeInTheDocument();
  });

  it('asks for the collector only when credit is required', () => {
    renderHebrew();
    expect(screen.queryByLabelText(new RegExp(HE['bulk.collector']))).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(HE['bulk.creditYes']));
    expect(screen.getByLabelText(new RegExp(HE['bulk.collector']))).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(HE['bulk.creditNo']));
    expect(screen.queryByLabelText(new RegExp(HE['bulk.collector']))).not.toBeInTheDocument();
  });

  it('rejects a non-YouTube link as soon as it is typed', () => {
    renderHebrew();
    fireEvent.change(screen.getByLabelText(HE['bulk.youtube']), { target: { value: 'https://vimeo.com/123' } });
    expect(screen.getByText(HE['bulk.err.youtube'])).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(HE['bulk.youtube']), { target: { value: 'https://youtu.be/dQw4w9WgXcQ' } });
    expect(screen.queryByText(HE['bulk.err.youtube'])).not.toBeInTheDocument();
  });

  it('adds items and copies dating and copyright to all of them', () => {
    renderHebrew();
    fireEvent.click(screen.getByRole('button', { name: HE['bulk.addItem'] }));
    fireEvent.click(screen.getByRole('button', { name: HE['bulk.addItem'] }));
    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(3);

    const first = cards[0];
    fireEvent.change(within(first).getByLabelText(HE['bulk.datingHint']), { target: { value: '1940-1950' } });
    fireEvent.click(within(first).getByLabelText(HE['bulk.creditYes']));
    fireEvent.change(within(first).getByLabelText(new RegExp(HE['bulk.collector'])), { target: { value: 'משפחת לוי' } });
    fireEvent.click(within(first).getByRole('button', { name: HE['bulk.applyToAll'] }));

    for (const card of screen.getAllByRole('article').slice(1)) {
      expect(within(card).getByLabelText(HE['bulk.datingHint'])).toHaveValue('1940-1950');
      expect(within(card).getByLabelText(HE['bulk.creditYes'])).toBeChecked();
      expect(within(card).getByLabelText(new RegExp(HE['bulk.collector']))).toHaveValue('משפחת לוי');
    }
  });

  it('every bulk string has a hand-written Hebrew translation', () => {
    const keys = Object.keys(en).filter((key) => key.startsWith('bulk.') || key === 'queue.queued' || key === 'wb.readingQueued');
    expect(keys.length).toBeGreaterThan(40);
    expect(keys.filter((key) => !HE[key])).toEqual([]);
  });
});

describe('the page gate', () => {
  it('sends someone without a session to sign in', async () => {
    gate.volunteer.mockResolvedValue(null);
    gate.profile.mockResolvedValue(null);
    await expect(BulkUploadPage()).rejects.toThrow('redirect:/login?next=/review/bulk-upload');
  });

  it('tells a pending account it is waiting for approval, and shows no form', async () => {
    gate.volunteer.mockResolvedValue(null);
    gate.profile.mockResolvedValue({ id: 'p', role: 'pending', email: 'new@example.org' });
    // AwaitingApproval is an async server component, so the page's answer is checked as an element.
    const page = await BulkUploadPage();
    expect(page.type).toBe(AwaitingApproval);
    expect(page.props).toEqual({ email: 'new@example.org' });
    expect(gate.redirect).not.toHaveBeenCalled();
  });

  it('shows the form to a content expert', async () => {
    gate.volunteer.mockResolvedValue({ id: 'e', role: 'volunteer', email: 'e@example.org' });
    render(<MessagesProvider catalogue={en}>{await BulkUploadPage()}</MessagesProvider>);
    expect(screen.getByRole('heading', { level: 1, name: en['bulk.title'] })).toBeInTheDocument();
    expect(screen.getByRole('article')).toBeInTheDocument();
  });
});
