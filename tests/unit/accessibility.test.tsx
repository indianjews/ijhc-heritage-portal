import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { en, format, type MessageKey } from '@/lib/i18n/messages';
import he from '@/lib/i18n/locales/he.json';
import { MessagesProvider } from '@/lib/i18n/provider';
import type { ItemDetail, Profile } from '@/lib/types';

/**
 * The accessibility standard in AGENTS.md (WCAG 2.0 AA / Israeli SI 5568),
 * held in place by tests: rendered checks of the layout, the statement, the
 * menus and the forms, plus source-wide guards that fail the build if a
 * future change adds an unnamed control, an unlabelled field, a removed focus
 * ring, a second <main>, or a colour token below the contrast the law needs.
 */

const HE = he as Record<string, string>;
const HEB = { ...en, ...HE } as Record<string, string>;
const reader = (catalogue: Record<string, string>) => (key: MessageKey, vars?: Record<string, string | number>) => format(catalogue[key] ?? en[key] ?? key, vars);

const m = vi.hoisted(() => ({ code: 'he', pathname: '/', signInError: null as null | { message: string } }));
vi.mock('next/font/google', () => {
  const font = () => ({ variable: 'font', className: 'font' });
  return { Heebo: font, IBM_Plex_Mono: font, Inter: font, Noto_Naskh_Arabic: font, Noto_Sans_Devanagari: font, Noto_Sans_Malayalam: font };
});
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, getAll: () => [] }), headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({
  usePathname: () => m.pathname, useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(), redirect: vi.fn(), notFound: vi.fn(),
}));
vi.mock('@/lib/i18n', () => ({
  getMessages: async () => {
    const catalogue = m.code === 'he' ? HEB : (en as Record<string, string>);
    return { t: reader(catalogue), language: { code: m.code }, dir: m.code === 'he' ? 'rtl' : 'ltr', catalogue };
  },
}));
vi.mock('@/components/masthead', () => ({ Masthead: () => <header><nav aria-label="Main">menu</nav></header> }));
vi.mock('@/components/stats', () => ({ Stats: () => null }));
vi.mock('@/components/problem-listener', () => ({ ProblemListener: () => null }));
vi.mock('@/lib/experiment-server', () => ({ currentBucket: async () => null }));
vi.mock('@/lib/supabase/browser', () => ({
  createBrowserSupabase: () => ({ auth: { signInWithPassword: async () => ({ error: m.signInError }) } }),
}));
// Workbench collaborators that fetch.
vi.mock('@/components/review-candidates', () => ({ ReviewCandidates: () => null }));
vi.mock('@/components/review-server-actions', () => ({ ReviewServerActions: () => null }));
vi.mock('@/components/review-draft-controls', () => ({ ReviewDraftControls: () => null }));
vi.mock('@/components/file-preview', () => ({ FilePreview: () => null }));
vi.mock('@/components/translation-deck', () => ({ TranslationDeck: () => null }));
vi.mock('@/lib/files/upload', () => ({ uploadSignedFile: vi.fn() }));

const { default: RootLayout } = await import('@/app/layout');
const { LegalPage } = await import('@/components/legal-page');
const { ACCESSIBILITY, ACCESSIBILITY_REVIEWED } = await import('@/lib/legal');
const { MastheadShell } = await import('@/components/masthead-shell');
const { LanguagePicker } = await import('@/components/language-picker');
const { LoginForm } = await import('@/components/login-form');
const { ReviewWorkbench } = await import('@/components/review-workbench');
const { BulkUploadFlow } = await import('@/components/bulk-upload-flow');

beforeEach(() => { m.code = 'he'; m.pathname = '/'; m.signInError = null; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function parse(html: string) {
  return new DOMParser().parseFromString(html, 'text/html');
}
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

// ── 1. Skip link, landmark, lang/dir, footer link ─────────────────────────
describe('root layout', () => {
  it.each([['he', 'rtl', 'דלג לתוכן הראשי', 'הצהרת נגישות'], ['en', 'ltr', 'Skip to main content', 'Accessibility statement']])(
    'in %s: lang/dir on <html>, skip link first, one <main id="main-content">, footer links the statement',
    async (code, dir, skip, statement) => {
      m.code = code;
      const doc = parse(renderToStaticMarkup(await RootLayout({ children: <h1>Page</h1> })));
      expect(doc.documentElement.getAttribute('lang')).toBe(code);
      expect(doc.documentElement.getAttribute('dir')).toBe(dir);

      const first = doc.body.querySelector(FOCUSABLE)!;
      expect(first.tagName).toBe('A');
      expect(first.getAttribute('href')).toBe('#main-content');
      expect(first.textContent).toBe(skip);

      const mains = doc.querySelectorAll('main');
      expect(mains).toHaveLength(1);
      expect(mains[0].id).toBe('main-content');
      expect(mains[0].getAttribute('tabindex')).toBe('-1');
      expect(doc.querySelectorAll('footer')).toHaveLength(1);

      const link = [...doc.querySelectorAll('footer a')].find((a) => a.getAttribute('href') === '/accessibility')!;
      expect(link.textContent).toBe(statement);
      // Every nav on the page is named, and no two share a name.
      const names = [...doc.querySelectorAll('nav')].map((n) => n.getAttribute('aria-label'));
      expect(names.every(Boolean)).toBe(true);
      expect(new Set(names).size).toBe(names.length);
    },
  );
});

// ── 2. The accessibility statement ────────────────────────────────────────
describe('/accessibility', () => {
  it.each([
    ['he', 'הצהרת נגישות', /תקן ישראלי 5568/, /WCAG\) 2\.0 ברמה AA/, /חומר היסטורי בארכיון/, /פנו למרכז וציינו את הפריט/],
    ['en', 'Accessibility statement', /Israeli Standard 5568/, /WCAG\) 2\.0 at level AA/, /Historical material in the archive/, /ask the Center, naming the item/],
  ])('renders in %s with the standard, the features, the archival note and how to ask', async (code, title, standard, wcag, archival, ask) => {
    m.code = code;
    render(await LegalPage({ documents: ACCESSIBILITY, officer: true }));
    const article = screen.getByRole('article');
    expect(article).toHaveAttribute('lang', code);
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual([title]);
    for (const pattern of [standard, wcag, archival, ask]) expect(article.textContent).toMatch(pattern);
    expect(article.textContent).toContain(ACCESSIBILITY_REVIEWED);
    // A tel: link, the number kept left-to-right inside Hebrew.
    const phone = within(article).getByRole('link', { name: /\+972/ });
    expect(phone.getAttribute('href')).toMatch(/^tel:\+972\d+$/);
    expect(phone.querySelector('bdi')).toHaveAttribute('dir', 'ltr');
  });

  it('no longer claims things the site does not do', () => {
    const all = JSON.stringify(ACCESSIBILITY);
    expect(all).not.toMatch(/dark and a light appearance|מצב בהיר ומצב כהה/);
    expect(all).not.toMatch(/18px rather than|ב-18 פיקסל/);
    expect(ACCESSIBILITY.en.updated).toBe(`Last reviewed: ${ACCESSIBILITY_REVIEWED}`);
  });
});

// ── 3. Navigation: the phone menu and the language picker ─────────────────
describe('menus', () => {
  const profile = { id: 'e', role: 'volunteer', email: 'e@example.org' } as Profile;

  it('the phone menu exposes its state, and Escape closes it and returns focus to its button', async () => {
    render(<MessagesProvider catalogue={HEB}><MastheadShell home={null} rule={null} language={null} profile={profile} queueCount={0} /></MessagesProvider>);
    const button = screen.getByRole('button', { name: HE['nav.openMenu'] });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const panel = document.getElementById(button.getAttribute('aria-controls')!)!;
    expect(panel).toBeInTheDocument();
    within(panel).getAllByRole('link')[0].focus();
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(document.getElementById('masthead-panel')).toBeNull();
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('the language picker is a disclosure, not an unkeyboarded ARIA menu, and Escape returns focus', () => {
    const languages = [
      { code: 'en', label_en: 'English', label_native: 'English', rtl: false },
      { code: 'he', label_en: 'Hebrew', label_native: 'עברית', rtl: true },
    ];
    render(<MessagesProvider catalogue={HEB}><LanguagePicker languages={languages as never} current="he" /></MessagesProvider>);
    const trigger = screen.getByRole('button', { name: /עברית/ });
    expect(trigger).not.toHaveAttribute('aria-haspopup');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const panel = document.getElementById(trigger.getAttribute('aria-controls')!)!;
    expect(panel).toHaveAttribute('role', 'group');
    expect(panel).toHaveAccessibleName(HE['language.prompt']);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0);
    expect(within(panel).getByRole('button', { name: /עברית/ })).toHaveAttribute('aria-current', 'true');
    within(panel).getByRole('button', { name: /English/ }).focus();
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });
});

// ── 4. Forms: names, errors and announcements ─────────────────────────────
describe('forms', () => {
  it('sign-in: a mode switch of pressed buttons, Hebrew wording, and the error tied to the fields', async () => {
    m.signInError = { message: 'Invalid login credentials' };
    render(<MessagesProvider catalogue={HEB}><LoginForm /></MessagesProvider>);
    const group = screen.getByRole('group', { name: HE['login.mode'] });
    expect(within(group).getByRole('button', { name: HE['nav.signIn'] })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('tab')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\bSign in\b/);

    fireEvent.change(screen.getByLabelText(HE['login.email']), { target: { value: 'a@example.org' } });
    fireEvent.change(screen.getByLabelText(HE['login.password']), { target: { value: 'wrong-password' } });
    fireEvent.submit(screen.getByLabelText(HE['login.email']).closest('form')!);
    const alert = await screen.findByRole('alert');
    for (const field of [screen.getByLabelText(HE['login.email']), screen.getByLabelText(HE['login.password'])]) {
      expect(field).toHaveAttribute('aria-invalid', 'true');
      expect(field.getAttribute('aria-describedby')).toContain(alert.id);
    }
  });

  it('review workbench: every catalogue field is named by its visible label', () => {
    const item = { id: 'one', title: 'Record', status: 'pending', category: 'documents', community: null, keywords: [], contributor_keywords: [],
      access: 'public', files: [], file: null, fields: [], analysis: null, contributor: null } as unknown as ItemDetail;
    render(<MessagesProvider catalogue={en as Record<string, string>}><ReviewWorkbench item={item} vocabulary={[]} families={[]} selectedFamilyIds={[]} siteLanguage="en" /></MessagesProvider>);
    expect(screen.getByLabelText(en['wb.title'])).toHaveValue('Record');
    expect(screen.getByLabelText(en['wb.provenance']).tagName).toBe('INPUT');
    for (const select of document.querySelectorAll('select')) expect(select).toHaveAccessibleName();
    for (const field of document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea')) {
      expect(field).toHaveAccessibleName();
    }
  });

  it('bulk upload: each error is announced and linked to its field', () => {
    render(<MessagesProvider catalogue={HEB}><BulkUploadFlow consentVersion="x" /></MessagesProvider>);
    fireEvent.click(screen.getByLabelText(HE['bulk.creditYes']));
    fireEvent.click(screen.getByRole('button', { name: /שליחת הכול/ }));
    const period = screen.getByLabelText(HE['bulk.datingHint']);
    expect(period).toHaveAttribute('aria-invalid', 'true');
    expect(document.getElementById(period.getAttribute('aria-describedby')!)).toHaveAttribute('role', 'alert');
    const collector = screen.getByLabelText(new RegExp(HE['bulk.collector']));
    expect(collector).toHaveAttribute('aria-invalid', 'true');
    expect(document.getElementById(collector.getAttribute('aria-describedby')!)).toHaveTextContent(HE['bulk.err.collector']);
    const media = screen.getByRole('group', { name: new RegExp(HE['bulk.media']) });
    expect(document.getElementById(media.getAttribute('aria-describedby')!)).toHaveTextContent(HE['bulk.err.media']);
    const credit = screen.getByRole('radiogroup');
    expect(credit).toHaveAccessibleName(new RegExp(HE['bulk.credit']));
  });

  it('bulk upload: the copyright question is required and says so when unanswered', () => {
    render(<MessagesProvider catalogue={HEB}><BulkUploadFlow consentVersion="x" /></MessagesProvider>);
    fireEvent.click(screen.getByRole('button', { name: /שליחת הכול/ }));
    const credit = screen.getByRole('radiogroup');
    expect(credit).toHaveAttribute('aria-required', 'true');
    expect(credit).toHaveAttribute('aria-invalid', 'true');
    expect(document.getElementById(credit.getAttribute('aria-describedby')!)).toHaveTextContent(HE['bulk.err.credit']);
  });
});

// ── 5. Source-wide guards ─────────────────────────────────────────────────
function sourceFiles(dir = path.join(process.cwd(), 'src')): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sourceFiles(p) : p.endsWith('.tsx') ? [p] : [];
  });
}
/** The file's code without its comments: a comment may name what the code must not do. */
function code(file: string) {
  return fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
function jsx(file: string) {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
function attributes(open: ts.JsxOpeningLikeElement) {
  return Object.fromEntries(open.attributes.properties.filter(ts.isJsxAttribute).map((a) => [a.name.getText(), a.initializer ? a.initializer.getText() : 'true']));
}
const where = (sf: ts.SourceFile, node: ts.Node) => `${path.relative(process.cwd(), sf.fileName)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;

describe('source guards', () => {
  it('no control removes the focus ring', () => {
    const offenders = sourceFiles().filter((f) => /\boutline-none\b/.test(code(f).replace(/main-content[\s\S]{0,200}?outline-none/, '')));
    expect(offenders.map((f) => path.relative(process.cwd(), f))).toEqual([]);
  });

  it('no page renders a second <main>', () => {
    const offenders = sourceFiles().filter((f) => !f.endsWith(path.join('app', 'layout.tsx')) && /<main[\s>]/.test(code(f)));
    expect(offenders.map((f) => path.relative(process.cwd(), f))).toEqual([]);
  });

  it('every button and link has a name: text, aria-label, aria-labelledby or title', () => {
    const issues: string[] = [];
    const hasText = (node: ts.Node): boolean => {
      let found = false;
      const visit = (n: ts.Node) => {
        if (found) return;
        if (ts.isJsxText(n) && n.getText().trim()) found = true;
        else if (ts.isJsxExpression(n) && n.expression && !ts.isJsxElement(n.expression) && !ts.isJsxSelfClosingElement(n.expression)
          && !ts.isConditionalExpression(n.expression) && !ts.isBinaryExpression(n.expression)) found = true;
        else ts.forEachChild(n, visit);
      };
      ts.forEachChild(node, visit);
      return found;
    };
    for (const file of sourceFiles()) {
      const sf = jsx(file);
      const visit = (n: ts.Node) => {
        const open = ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : null;
        if (open && ['button', 'a', 'Link'].includes(open.tagName.getText())) {
          const a = attributes(open);
          const spread = open.attributes.properties.some(ts.isJsxSpreadAttribute);
          if (!a['aria-label'] && !a['aria-labelledby'] && !a.title && !spread && !(ts.isJsxElement(n) && hasText(n))) issues.push(where(sf, open));
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(issues).toEqual([]);
  });

  it('every form field has a label (or is a hidden helper, or a FieldRow child named at runtime)', () => {
    const issues: string[] = [];
    for (const file of sourceFiles()) {
      const sf = jsx(file);
      const text = sf.getFullText();
      const htmlFor = [...text.matchAll(/htmlFor=\{?([^}\s>]+)\}?/g)].map((x) => x[1].replace(/^["'`]|["'`]$/g, ''));
      const visit = (n: ts.Node, inLabel: boolean, parent: string) => {
        const open = ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : null;
        const tag = open?.tagName.getText() ?? '';
        if (open && ['input', 'select', 'textarea'].includes(tag)) {
          const a = attributes(open);
          const type = (a.type ?? '').replace(/["']/g, '');
          const id = (a.id ?? '').replace(/^\{|\}$/g, '').replace(/^["'`]|["'`]$/g, '');
          const named = inLabel || a['aria-label'] || a['aria-labelledby'] || ['hidden', 'submit'].includes(type)
            || (a['aria-hidden'] && a.tabIndex === '{-1}') || parent === 'FieldRow'
            || (id && htmlFor.some((h) => h === id || h.includes(id) || id.includes(h)));
          if (!named) issues.push(where(sf, open));
        }
        ts.forEachChild(n, (c) => visit(c, inLabel || tag === 'label', open && ts.isJsxElement(n) ? tag : parent));
      };
      visit(sf, false, '');
    }
    expect(issues).toEqual([]);
  });

  it('no ARIA menu or tab roles without their keyboard pattern', () => {
    const offenders = sourceFiles().filter((f) => /role="(menu|menuitem|menuitemradio|tab|tablist)"/.test(code(f)));
    expect(offenders.map((f) => path.relative(process.cwd(), f))).toEqual([]);
  });
});

// ── 6. Contrast of the tokens themselves ──────────────────────────────────
describe('colour contrast (WCAG 1.4.3, and 3:1 for controls)', () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8');
  const token = (name: string) => css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})`, 'i'))![1];
  const lum = (hex: string) => {
    const [r, g, b] = hex.slice(1).match(/../g)!.map((x) => parseInt(x, 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const grounds = ['paper', 'paper-2', 'paper-3', 'surface', 'surface-2', 'accent-wash'];

  it.each(['ink', 'muted', 'accent', 'accent-strong', 'caution', 'critical'])('text in %s is at least 4.5:1 on every ground', (fg) => {
    for (const bg of grounds) expect(ratio(token(fg), token(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it('button text on the filled buttons and the queue badge is at least 4.5:1', () => {
    expect(ratio('#ffffff', token('primary'))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(token('paper'), token('accent-strong'))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['control', 'accent-strong'])('UI boundary %s (field edge, focus ring) is at least 3:1 on every ground', (fg) => {
    for (const bg of grounds) expect(ratio(token(fg), token(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
  });

  it('placeholders use the muted token, not a faint default', () => {
    expect(css).toMatch(/::placeholder\s*\{\s*color:\s*var\(--color-muted\);\s*opacity:\s*1;/);
  });
});

