import { describe, expect, it } from 'vitest';
import { ARCHIVE_ORIGIN, archiveUserAgent } from '@/lib/links/policy';

describe('archiveUserAgent', () => {
  it('names the configured site address', () => {
    expect(archiveUserAgent('https://example.org')).toBe('IJHC-Heritage-Archive/1.0 (+https://example.org)');
  });

  it('drops trailing slashes and surrounding whitespace', () => {
    expect(archiveUserAgent('  https://example.org///  ')).toBe('IJHC-Heritage-Archive/1.0 (+https://example.org)');
  });

  it('falls back to the Center’s production domain when unset or blank', () => {
    expect(ARCHIVE_ORIGIN).toBe('https://archive.indianjews.org');
    expect(archiveUserAgent(undefined)).toBe('IJHC-Heritage-Archive/1.0 (+https://archive.indianjews.org)');
    expect(archiveUserAgent('   ')).toBe('IJHC-Heritage-Archive/1.0 (+https://archive.indianjews.org)');
  });

  it('never names the old personal deployment', () => {
    expect(archiveUserAgent(undefined)).not.toContain('snowy');
  });
});
