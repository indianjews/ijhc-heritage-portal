'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarRange } from 'lucide-react';
import { buttonClass } from '@/components/primitives';
import { useMessages } from '@/lib/i18n/provider';
import type { MessageKey } from '@/lib/i18n/messages';
import { israelToday, validateWindow, windowState } from '@/lib/upload/archive-access';
import type { Profile } from '@/lib/types';

/**
 * An administrator's control for a pending account's archive-upload window
 * (0043): from and until, inclusive, Israel dates; both set or both cleared.
 * The window opens /archive-upload and nothing else.
 */
export function ArchiveWindowEditor({ profile }: { profile: Profile }) {
  const t = useMessages();
  const router = useRouter();
  const id = useId();
  const [from, setFrom] = useState(profile.archive_upload_from ?? '');
  const [until, setUntil] = useState(profile.archive_upload_until ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const state = windowState(profile, israelToday());
  const stateText = state === 'none'
    ? t('accounts.window.none')
    : t(`accounts.window.${state}` as MessageKey, { from: profile.archive_upload_from!, until: profile.archive_upload_until! });

  async function save(nextFrom: string, nextUntil: string) {
    setSaved(null);
    const problem = validateWindow(nextFrom || null, nextUntil || null);
    if (problem) { setError(t(problem)); return; }
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/manage/accounts/${profile.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ archiveUploadFrom: nextFrom || null, archiveUploadUntil: nextUntil || null }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok) {
        const message = body?.error?.message as string | undefined;
        setError(message?.startsWith('accounts.window.') ? t(message as MessageKey) : message ?? t('error.didNotGoThrough'));
        return;
      }
      setFrom(nextFrom); setUntil(nextUntil);
      setSaved(t(nextFrom ? 'accounts.window.saved' : 'accounts.window.cleared'));
      router.refresh();
    } catch {
      setError(t('error.didNotGoThrough'));
    } finally {
      setBusy(false);
    }
  }

  const errorId = `${id}-error`;
  return (
    <fieldset className="mt-3 w-full rounded-xl border border-rule p-3" disabled={busy}>
      <legend className="flex items-center gap-2 px-1 text-sm font-medium">
        <CalendarRange size={16} aria-hidden /> {t('accounts.window.legend')}
      </legend>
      <p className={state === 'active' ? 'text-sm font-medium text-positive' : 'text-sm text-muted'}>{stateText}</p>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="mb-1 block text-sm">{t('accounts.window.from')}</span>
          <input type="date" dir="ltr" value={from} max={until || undefined} onChange={(e) => setFrom(e.target.value)}
            aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
            className="min-h-11 rounded-lg border border-control bg-paper px-3" />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm">{t('accounts.window.until')}</span>
          <input type="date" dir="ltr" value={until} min={from || undefined} onChange={(e) => setUntil(e.target.value)}
            aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
            className="min-h-11 rounded-lg border border-control bg-paper px-3" />
        </label>
        <button type="button" className={buttonClass('primary', undefined, 'sm')} onClick={() => save(from, until)}>
          {t('accounts.window.save')}
        </button>
        {(profile.archive_upload_from || from || until) && (
          <button type="button" className={buttonClass('quiet', undefined, 'sm')} onClick={() => save('', '')}>
            {t('accounts.window.clear')}
          </button>
        )}
      </div>
      {error && <p id={errorId} role="alert" className="mt-2 text-sm text-critical">{error}</p>}
      <p role="status" className="mt-1 text-sm text-muted">{saved}</p>
    </fieldset>
  );
}
