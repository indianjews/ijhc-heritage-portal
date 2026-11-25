'use client';

import Link from 'next/link';
import { Copy } from 'lucide-react';
import { useMessages } from '@/lib/i18n/provider';
import type { DuplicateHint } from '@/lib/files/duplicate-hint';

/**
 * "This file seems to be in the archive already" — for the contributor, on
 * the upload screen, and never in the way.
 *
 * It does not block or warn in red: a second copy of a photograph often
 * arrives with the one thing the first lacked — a name, a date, a place. It
 * links only to a record that is published to everyone; a match on anything
 * else reads the same as a match on nothing published (duplicate-hint.ts).
 */
export function DuplicateNotice({ files }: { files: { fileName: string; duplicate?: DuplicateHint }[] }) {
  const t = useMessages();
  const matches = files.filter((file) => file.duplicate);
  if (!matches.length) return null;
  return (
    <section role="status" aria-labelledby="duplicate-notice-heading" className="mt-5 rounded-lg border-s-[3px] border-accent bg-accent-wash px-4 py-3.5">
      <h3 id="duplicate-notice-heading" className="flex items-center gap-2 font-medium">
        <Copy size={16} aria-hidden /> {t('upload.duplicate.heading')}
      </h3>
      <ul className="mt-2 space-y-1.5">
        {matches.map((file) => (
          <li key={file.fileName} className="leading-relaxed">
            {t('upload.duplicate.file', { name: '⁨' + file.fileName + '⁩' })}
            {file.duplicate?.publishedId && (
              <>
                {' '}
                <Link
                  href={`/portal/${file.duplicate.publishedId}`}
                  target="_blank"
                  className="inline-flex min-h-11 items-center underline underline-offset-2"
                >
                  {t('upload.duplicate.view')}
                </Link>
              </>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-sm text-muted">{t('upload.duplicate.proceed')}</p>
    </section>
  );
}
