import { redirect } from 'next/navigation';
import { getCurrentVolunteer } from '@/lib/supabase/server';
import type { Metadata } from 'next';
import { getMessages } from '@/lib/i18n';
import { RecordingUploadFlow } from '@/components/recording-upload-flow';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getMessages();
  return { title: t('upload.recording.title') };
}

export default async function RecordingUploadPage() {
  const volunteer = await getCurrentVolunteer();
  if (!volunteer) redirect('/login?next=/upload/recording');

  const { t } = await getMessages();

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-var(--masthead-h)-4.5rem)] max-w-6xl flex-col justify-center px-6 pt-4 pb-10 sm:pt-6">
      <div className="mb-6">
        <p className="eyebrow mb-1">{t('upload.recording.eyebrow')}</p>
        <h1 className="font-display text-3xl">{t('upload.recording.headline')}</h1>
        <p className="mt-2 text-muted">{t('upload.recording.standfirst')}</p>
      </div>
      <RecordingUploadFlow />
    </div>
  );
}
