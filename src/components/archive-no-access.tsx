import Link from 'next/link';
import { getMessages } from '@/lib/i18n';
import type { Profile } from '@/lib/types';
import { israelToday, windowState } from '@/lib/upload/archive-access';
import { buttonClass } from '@/components/primitives';

/**
 * What someone who may not use /archive-upload is told: plainly, with the
 * dates if a window was granted, and where to go instead. Never the form.
 */
export async function ArchiveNoAccess({ profile }: { profile: Profile | null }) {
  const { t } = await getMessages();
  const state = profile ? windowState(profile, israelToday()) : 'none';
  const body = !profile
    ? t('archive.noAccessSignIn')
    : state === 'scheduled'
      ? t('archive.noAccessScheduled', { from: profile.archive_upload_from!, until: profile.archive_upload_until! })
      : state === 'ended'
        ? t('archive.noAccessEnded', { until: profile.archive_upload_until! })
        : t('archive.noAccessBody');
  return (
    <div className="mx-auto max-w-2xl px-6 py-14">
      <h1 className="font-display text-3xl">{t('archive.noAccess')}</h1>
      <p className="mt-4 leading-relaxed text-muted">{body}</p>
      <div className="mt-8 flex flex-wrap gap-3">
        {profile
          ? <Link href="/upload" className={buttonClass('primary')}>{t('nav.contribute')}</Link>
          : <Link href="/login?next=/archive-upload" className={buttonClass('primary')}>{t('nav.signIn')}</Link>}
        <Link href="/portal" className={buttonClass('quiet')}>{t('common.backToPortal')}</Link>
      </div>
    </div>
  );
}
