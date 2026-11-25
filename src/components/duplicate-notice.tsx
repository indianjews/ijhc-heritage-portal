'use client';

import Link from 'next/link';
import { Copy } from 'lucide-react';
import { useMessages } from '@/lib/i18n/provider';
import { batchDuplicates, earlierUploadHref, type DuplicateHint } from '@/lib/files/duplicate-hint';

/**
 * "Uploaded twice?" — on /upload, about the person's own double uploads only,
 * and never in the way.
 *
 * Two kinds (see src/lib/files/duplicate-hint.ts): the same file twice in this
 * upload, or a file this signed-in user already sent in an earlier record.
 * Someone else having sent the same file is never mentioned: a second copy
 * from another person often brings the story the first lacked.
 */

type Entry = { id?: string; fileName: string; checksum?: string | null; duplicate?: DuplicateHint };

/** The server's "earlier" hint where there is one, else "batch" for a repeated file in this upload. */
export function withBatchDuplicates<T extends { id: string; checksum?: string | null; duplicate?: DuplicateHint }>(files: T[]): T[] {
  const repeated = batchDuplicates(files);
  return files.map((file) => (file.duplicate || !repeated.has(file.id) ? file : { ...file, duplicate: { kind: 'batch' } }));
}

export function DuplicateNotice({ files }: { files: Entry[] }) {
  const t = useMessages();
  const matches = files.filter((file) => file.duplicate);
  if (!matches.length) return null;
  return (
    <section role="status" aria-labelledby="duplicate-notice-heading" className="mt-5 rounded-lg border-s-[3px] border-accent bg-accent-wash px-4 py-3.5">
      <h3 id="duplicate-notice-heading" className="flex items-center gap-2 font-medium">
        <Copy size={16} aria-hidden /> {t('upload.duplicate.heading')}
      </h3>
      <ul className="mt-2 space-y-1.5">
        {matches.map((file, index) => {
          const name = '⁨' + file.fileName + '⁩';
          const hint = file.duplicate!;
          return (
            <li key={file.id ?? `${file.fileName}-${index}`} className="leading-relaxed">
              {hint.kind === 'batch' ? t('upload.duplicate.batch', { name }) : t('upload.duplicate.earlier', { name })}
              {hint.kind === 'earlier' && (
                <>
                  {' '}
                  <Link href={earlierUploadHref(hint)} target="_blank" className="inline-flex min-h-11 items-center underline underline-offset-2">
                    {t('upload.duplicate.view')}
                  </Link>
                </>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-sm text-muted">{t('upload.duplicate.proceed')}</p>
    </section>
  );
}
