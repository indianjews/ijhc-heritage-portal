import type { Metadata } from 'next';
import { ArchiveNoAccess } from '@/components/archive-no-access';
import { getMessages } from '@/lib/i18n';
import { getCurrentProfile } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getMessages();
  return { title: t('archive.noAccess') };
}

/** Where the proxy sends anyone it refuses at /archive-upload (served with a 403). */
export default async function ArchiveNoAccessPage() {
  return <ArchiveNoAccess profile={await getCurrentProfile()} />;
}
