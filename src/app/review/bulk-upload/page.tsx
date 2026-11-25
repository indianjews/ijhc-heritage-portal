import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AwaitingApproval } from '@/components/awaiting-approval';
import { BulkUploadFlow } from '@/components/bulk-upload-flow';
import { getMessages } from '@/lib/i18n';
import { CONSENT_VERSION } from '@/lib/consent';
import { getCurrentProfile, getCurrentVolunteer } from '@/lib/supabase/server';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getMessages();
  return { title: t('bulk.title') };
}

/**
 * Bulk upload for content experts and administrators.
 *
 * Three gates, as for every closed screen: the proxy sends anyone without a
 * session to sign in (/review is closed there), this render checks the role,
 * and the route that creates each item checks it again.
 */
export default async function BulkUploadPage() {
  const volunteer = await getCurrentVolunteer();
  if (!volunteer) {
    const profile = await getCurrentProfile();
    if (profile) return <AwaitingApproval email={profile.email} />;
    redirect('/login?next=/review/bulk-upload');
  }

  const { t } = await getMessages();
  return (
    <div className="mx-auto max-w-3xl px-4 pt-8 pb-14 sm:px-6 sm:pt-12 sm:pb-16">
      <p className="mb-4 text-sm">
        <Link href="/review" className="inline-flex min-h-11 items-center underline underline-offset-4">{t('bulk.back')}</Link>
      </p>
      <header className="mb-8 max-w-2xl">
        <p className="eyebrow">{t('queue.volunteersOnly')}</p>
        <h1 className="mt-3 font-display text-3xl leading-tight sm:text-4xl">{t('bulk.title')}</h1>
        <p className="mt-4 leading-relaxed text-muted">{t('bulk.intro')}</p>
      </header>
      <BulkUploadFlow consentVersion={CONSENT_VERSION} />
    </div>
  );
}
