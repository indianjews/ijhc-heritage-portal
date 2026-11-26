import type { Metadata } from 'next';
import { ArchiveUploadFlow } from '@/components/archive-upload-flow';
import { ArchiveNoAccess } from '@/components/archive-no-access';
import { getMessages } from '@/lib/i18n';
import { CONSENT_VERSION } from '@/lib/consent';
import { getCurrentProfile } from '@/lib/supabase/server';
import { getArchiveUploader } from '@/lib/upload/archive-access-server';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getMessages();
  return { title: t('archive.title') };
}

/**
 * Archive upload. Four gates, as the decision of 26.11.2026 asks: the proxy
 * (session + can_archive_upload()), this render (the same database answer),
 * the upload route (again), and the database function itself.
 */
export default async function ArchiveUploadPage() {
  const uploader = await getArchiveUploader();
  if (!uploader) return <ArchiveNoAccess profile={await getCurrentProfile()} />;

  const { t } = await getMessages();
  return (
    <div className="mx-auto max-w-3xl px-4 pt-8 pb-14 sm:px-6 sm:pt-12 sm:pb-16">
      <header className="mb-8 max-w-2xl">
        <h1 className="font-display text-3xl leading-tight sm:text-4xl">{t('archive.title')}</h1>
        <p className="mt-4 leading-relaxed text-muted">{t('archive.intro')}</p>
        {uploader.access === 'window' && (
          <p className="mt-3 rounded-lg border-s-[3px] border-accent bg-accent-wash px-4 py-2 text-sm">
            {t('archive.windowNote', { until: uploader.profile.archive_upload_until ?? '' })}
          </p>
        )}
      </header>
      <ArchiveUploadFlow consentVersion={CONSENT_VERSION} expert={uploader.access === 'expert'} />
    </div>
  );
}
