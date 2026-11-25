'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMessages } from '@/lib/i18n/provider';
import { buttonClass } from './primitives';

/** Resolve or dismiss a private problem report (0042). Experts only; the route and RLS check again. */
export function ReportDecision({ id }: { id: string }) {
  const t = useMessages();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function decide(status: 'resolved' | 'dismissed') {
    setBusy(true); setMessage('');
    try {
      const response = await fetch(`/api/reports/${id}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }) });
      const result = await response.json();
      if (!result.ok) setMessage(result.error.message);
      else { setMessage(t('public.decided')); router.refresh(); }
    } catch { setMessage(t('public.failed')); }
    finally { setBusy(false); }
  }
  return <div className="mt-5">
    <div className="flex flex-wrap gap-3">
      <button type="button" className={buttonClass('accent')} disabled={busy} onClick={() => decide('resolved')}>{t('report.resolve')}</button>
      <button type="button" className={buttonClass('quiet')} disabled={busy} onClick={() => decide('dismissed')}>{t('report.dismiss')}</button>
    </div>
    <p role="status" className="mt-3">{message}</p>
  </div>;
}
