import { describe, expect, it } from 'vitest';
import {
  BulkItemBody,
  bulkFileAccepted,
  bulkItemValues,
  cardErrors,
  deriveTitle,
  isVideo,
  parsePeriod,
  type CardInput,
} from '@/lib/items/bulk-upload';

/**
 * The rules of one bulk-upload item. The same predicates drive the screen's
 * inline errors and the route's refusal, so testing them once covers both.
 */

const NOW = new Date('2026-11-25T12:00:00Z');
const file = (over: Record<string, unknown> = {}) => ({
  path: 'uploads/2026/11/a-flyer.jpg', grant: 'g', expiresAt: Date.now() + 60_000,
  fileName: 'flyer.jpg', mimeType: 'image/jpeg', byteSize: 1000, ...over,
});
const body = (over: Record<string, unknown> = {}) => ({
  periodUnknown: false, period: '1952', creditRequired: false, consentVersion: '2026-09-07', files: [file()], ...over,
});
const card = (over: Partial<CardInput> = {}): CardInput => ({
  fileCount: 1, youtubeUrl: '', period: '1952', periodUnknown: false, creditRequired: false, collectorName: '', ...over,
});

function issues(input: unknown): Record<string, string> {
  const result = BulkItemBody.safeParse(input);
  if (result.success) return {};
  return Object.fromEntries(result.error.issues.map((i) => [i.path.join('.') || 'form', i.message]));
}

describe('media first', () => {
  it('needs at least one file or a YouTube link', () => {
    expect(cardErrors(card({ fileCount: 0 }))).toMatchObject({ media: 'bulk.err.media' });
    expect(issues(body({ files: [] }))).toMatchObject({ media: 'bulk.err.media' });
  });

  it('accepts a YouTube link alone, and a flyer with a YouTube link', () => {
    expect(issues(body({ files: [], youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ' }))).toEqual({});
    expect(issues(body({ youtubeUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }))).toEqual({});
  });

  it('accepts only images and videos from the regular allow-list', () => {
    expect(bulkFileAccepted('image/jpeg')).toBe(true);
    expect(bulkFileAccepted('video/mp4')).toBe(true);
    expect(bulkFileAccepted('application/pdf')).toBe(false);
    expect(bulkFileAccepted('audio/mpeg')).toBe(false);
    expect(bulkFileAccepted('image/svg+xml')).toBe(false);
    expect(issues(body({ files: [file({ mimeType: 'application/pdf' })] }))).toMatchObject({ 'files.0.mimeType': 'bulk.err.fileTypeServer' });
    expect(isVideo('video/quicktime')).toBe(true);
    expect(isVideo('image/png')).toBe(false);
  });
});

describe('YouTube only', () => {
  it.each([
    'https://vimeo.com/123456',
    'https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
    'https://example.org/?v=dQw4w9WgXcQ',
    'javascript:alert(1)',
    'https://www.youtube.com/watch?v=short',
    'not a url',
  ])('rejects %s', (url) => {
    expect(cardErrors(card({ youtubeUrl: url }))).toMatchObject({ youtube: 'bulk.err.youtube' });
    expect(issues(body({ youtubeUrl: url }))).toMatchObject({ youtube: 'bulk.err.youtube' });
  });

  it.each([
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=10',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
  ])('accepts %s', (url) => {
    expect(cardErrors(card({ youtubeUrl: url }))).toEqual({});
  });

  it('does not let a bad link stand in for media', () => {
    expect(cardErrors(card({ fileCount: 0, youtubeUrl: 'https://vimeo.com/1' }))).toEqual({ youtube: 'bulk.err.youtube' });
  });
});

describe('dating is required, or explicitly unknown', () => {
  it('parses a year or a range, normalising dashes and spaces', () => {
    expect(parsePeriod('1952', NOW)).toBe('1952');
    expect(parsePeriod(' 1940 – 1950 ', NOW)).toBe('1940-1950');
    expect(parsePeriod('1940-1940', NOW)).toBe('1940');
    expect(parsePeriod('850', NOW)).toBe('850');
  });

  it.each(['1950s', 'c. 1950', '1950-1940', '2030', '1950-2030', '19', '1940-1950-1960', ''])('refuses %j', (text) => {
    expect(parsePeriod(text, NOW)).toBeNull();
  });

  it('requires a value unless "Date unknown" is ticked', () => {
    expect(cardErrors(card({ period: '' }))).toMatchObject({ period: 'bulk.err.period' });
    expect(cardErrors(card({ period: 'sometime' }))).toMatchObject({ period: 'bulk.err.periodFormat' });
    expect(cardErrors(card({ period: '', periodUnknown: true }))).toEqual({});
    expect(issues(body({ period: '', periodUnknown: true }))).toEqual({});
    expect(issues(body({ period: '1952', periodUnknown: true }))).toMatchObject({ period: 'bulk.err.periodBoth' });
  });

  it('stores null for an unknown date and the normalised text otherwise', () => {
    expect(bulkItemValues(BulkItemBody.parse(body({ period: undefined, periodUnknown: true }))).period).toBeNull();
    expect(bulkItemValues(BulkItemBody.parse(body({ period: '1940 - 1950' })), NOW).period).toBe('1940-1950');
  });
});

describe('copyright is an explicit yes or no', () => {
  it('has no default: an unanswered question is an error', () => {
    expect(cardErrors(card({ creditRequired: null }))).toMatchObject({ credit: 'bulk.err.credit' });
    const { creditRequired: _omitted, ...withoutAnswer } = body();
    void _omitted;
    expect(issues(withoutAnswer)).toMatchObject({ creditRequired: 'bulk.err.credit' });
  });

  it('needs the collector name when credit is required', () => {
    expect(cardErrors(card({ creditRequired: true, collectorName: '  ' }))).toMatchObject({ collector: 'bulk.err.collector' });
    expect(issues(body({ creditRequired: true }))).toMatchObject({ collectorName: 'bulk.err.collector' });
    expect(issues(body({ creditRequired: true, collectorName: 'Levi family' }))).toEqual({});
  });

  it('maps the answer onto the record, dropping a stray name when the answer is No', () => {
    const yes = bulkItemValues(BulkItemBody.parse(body({ creditRequired: true, collectorName: ' Levi family ' })));
    expect(yes).toMatchObject({ collectorCreditRequired: true, collectorName: 'Levi family' });
    const no = bulkItemValues(BulkItemBody.parse(body({ creditRequired: false, collectorName: 'ignored' })));
    expect(no).toMatchObject({ collectorCreditRequired: false, collectorName: null });
  });
});

describe('temporary title', () => {
  it('prefers a typed title, then the first line of the notes, then the YouTube title, then the file name', () => {
    expect(deriveTitle({ title: 'Typed', description: 'Notes', fileNames: ['a.jpg'] })).toBe('Typed');
    expect(deriveTitle({ description: '\n  Purim party, Mumbai  \nmore', youtubeTitle: 'YT', fileNames: ['a.jpg'] })).toBe('Purim party, Mumbai');
    expect(deriveTitle({ description: '   ', youtubeTitle: 'Lecture on Cochin', fileNames: ['a.jpg'] })).toBe('Lecture on Cochin');
    expect(deriveTitle({ fileNames: ['IMG_2041_scan.jpeg'] })).toBe('IMG 2041 scan');
  });

  it('is always 1 to 200 characters', () => {
    const long = deriveTitle({ description: 'א'.repeat(500), fileNames: [] });
    expect(Array.from(long)).toHaveLength(200);
    expect(long.endsWith('…')).toBe(true);
    expect(deriveTitle({ fileNames: [], now: NOW })).toBe('Bulk upload 2026-11-25');
  });
});
