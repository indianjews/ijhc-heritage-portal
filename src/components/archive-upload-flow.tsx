'use client';

import Link from 'next/link';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileText, FolderUp, Loader2, Plus, Sparkles, Trash2 } from 'lucide-react';
import { buttonClass } from '@/components/primitives';
import { useMessages } from '@/lib/i18n/provider';
import type { MessageKey } from '@/lib/i18n/messages';
import { uploadSignBody } from '@/lib/files/hash';
import { uploadSignedFile } from '@/lib/files/upload';
import { measureDuration } from '@/lib/files/measure';
import { validateFile } from '@/lib/files/validate';
import { cardErrors, isVideo, type CardErrorKey, type CardField } from '@/lib/items/bulk-upload';
import { MAX_SIDECAR_CHARS, groupArchiveFiles, mediaType, sidecarText, type ArchiveGroup } from '@/lib/upload/archive-pairing';
import { cn } from '@/lib/utils';

/**
 * The archive upload: a folder (or a handful of files) in, archive items out,
 * paired by name (src/lib/upload/archive-pairing.ts).
 *
 * Nothing here calls the model. An item with a .txt beside it is described by
 * that text and skips the reading; an item without one is queued for the
 * quiet-hours reading. Items go one request each, so a large folder never
 * meets the platform's time limit and a failure costs one item, not the batch.
 */

interface Picked {
  id: string;
  file: File;
  name: string;
  type: string;
  relativePath?: string;
}

type ItemStatus = 'waiting' | 'sending' | 'done' | 'error';
interface Outcome { status: ItemStatus; error?: string; link?: string }

/** A grant this close to expiry is not reused on a retry. */
const GRANT_MARGIN_MS = 5 * 60_000;
const inputClass = 'min-h-11 w-full rounded-lg border border-control bg-paper px-3 py-2 text-start';

export function ArchiveUploadFlow({ consentVersion, expert }: { consentVersion: string; expert: boolean }) {
  const t = useMessages();
  const id = useId();
  const folderInput = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [period, setPeriod] = useState('');
  const [periodUnknown, setPeriodUnknown] = useState(false);
  const [creditRequired, setCreditRequired] = useState<boolean | null>(null);
  const [collectorName, setCollectorName] = useState('');
  const [consented, setConsented] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ index: number; total: number } | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const uploads = useRef(new Map<string, { path: string; grant: string; expiresAt: number; durationMs: number | null; mimeType: string }>());

  // A folder picker is a non-standard attribute React does not know; set it on the element.
  useEffect(() => {
    folderInput.current?.setAttribute('webkitdirectory', '');
    folderInput.current?.setAttribute('directory', '');
  }, []);

  const grouping = useMemo(() => groupArchiveFiles(picked), [picked]);
  const errors = cardErrors({ fileCount: 1, youtubeUrl: '', period, periodUnknown, creditRequired, collectorName });
  const shown = (field: CardField): string | undefined => (showErrors && errors[field] ? t(errors[field] as CardErrorKey) : undefined);
  const pendingItems = grouping.items.filter((item) => outcomes[item.key]?.status !== 'done');
  const failed = grouping.items.filter((item) => outcomes[item.key]?.status === 'error').length;
  const done = grouping.items.length - pendingItems.length;
  const unsent = pendingItems.length > 0;

  useEffect(() => {
    if (!unsent && !running) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsent, running]);

  function add(list: FileList | null) {
    const files = Array.from(list ?? []).map((file) => ({
      id: crypto.randomUUID(), file, name: file.name, type: file.type,
      relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || undefined,
    }));
    if (files.length) setPicked((previous) => [...previous, ...files]);
  }

  async function uploadFile(entry: Picked) {
    const known = uploads.current.get(entry.id);
    if (known && known.expiresAt - Date.now() > GRANT_MARGIN_MS) return known;
    const mimeType = mediaType(entry);
    const rejection = validateFile({ mimeType, byteSize: entry.file.size });
    if (rejection) throw new Error(t(rejection.key, rejection.vars));
    // The browser may give no type for .tif or .mov; the name's is used instead.
    const signResponse = await fetch('/api/uploads/sign', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(await uploadSignBody(entry.file)), mimeType }),
    });
    const signed = await signResponse.json().catch(() => null);
    if (!signed?.ok) throw new Error(signed?.error?.message ?? t('bulk.err.upload'));
    const { error } = await uploadSignedFile(signed.data.path, signed.data.token, entry.file);
    if (error) throw new Error(t('bulk.err.upload'));
    const uploaded = { path: signed.data.path, grant: signed.data.grant, expiresAt: signed.data.expiresAt, durationMs: await measureDuration(entry.file), mimeType };
    uploads.current.set(entry.id, uploaded);
    return uploaded;
  }

  async function sendOne(item: ArchiveGroup<Picked>): Promise<Outcome> {
    let description: string | undefined;
    if (item.text) {
      description = sidecarText(await item.text.file.text());
      if (description.length > MAX_SIDECAR_CHARS) return { status: 'error', error: t('archive.err.textTooLong') };
    }
    const files = [];
    for (const entry of item.media) {
      const uploaded = await uploadFile(entry);
      files.push({ path: uploaded.path, grant: uploaded.grant, expiresAt: uploaded.expiresAt, fileName: entry.name,
        mimeType: uploaded.mimeType, byteSize: entry.file.size, durationMs: uploaded.durationMs });
    }
    const response = await fetch('/api/items/archive-upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: item.displayName, description, skipAi: item.skipAi && Boolean(description),
        period: periodUnknown ? undefined : period.trim(), periodUnknown, creditRequired,
        collectorName: creditRequired ? collectorName.trim() : undefined, consentVersion, files,
      }),
    });
    const result = await response.json().catch(() => null);
    if (!result?.ok) {
      const message = result?.error?.message as string | undefined;
      return { status: 'error', error: message && (message.startsWith('bulk.') || message.startsWith('archive.')) ? t(message as MessageKey) : message ?? t('bulk.err.failed') };
    }
    return { status: 'done', link: expert ? `/review/${result.data.id}` : `/receipt/${result.data.id}?t=${encodeURIComponent(result.data.receipt)}` };
  }

  async function submit() {
    if (running) return;
    setShowErrors(true);
    if (Object.keys(errors).length || !consented || !pendingItems.length) return;
    setRunning(true);
    const queue = pendingItems;
    try {
      for (let index = 0; index < queue.length; index++) {
        const item = queue[index];
        setProgress({ index: index + 1, total: queue.length });
        setOutcomes((previous) => ({ ...previous, [item.key]: { status: 'sending' } }));
        let outcome: Outcome;
        try { outcome = await sendOne(item); }
        catch (error) { outcome = { status: 'error', error: error instanceof Error ? error.message : t('bulk.err.failed') }; }
        setOutcomes((previous) => ({ ...previous, [item.key]: outcome }));
      }
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  const orphanId = `${id}-orphans`;
  return (
    <div className="space-y-8">
      {/* ── 1. the files ─────────────────────────────────────────────── */}
      <section aria-labelledby={`${id}-files`} className="space-y-4">
        <h2 id={`${id}-files`} className="font-display text-2xl">{t('archive.files')}</h2>
        <p className="text-muted">{t('archive.filesHint')}</p>
        <div className="flex flex-wrap gap-3">
          <label className={buttonClass('primary', 'cursor-pointer')}>
            <FolderUp size={18} aria-hidden /> {t('archive.chooseFolder')}
            <input ref={folderInput} type="file" multiple className="sr-only" disabled={running}
              onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
          </label>
          <label className={buttonClass('quiet', 'cursor-pointer')}>
            <Plus size={18} aria-hidden /> {t('archive.chooseFiles')}
            <input type="file" multiple className="sr-only" disabled={running}
              onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
          </label>
          {picked.length > 0 && !running && (
            <button type="button" className={buttonClass('quiet')} onClick={() => { setPicked([]); setOutcomes({}); uploads.current.clear(); }}>
              <Trash2 size={18} aria-hidden /> {t('archive.clear')}
            </button>
          )}
        </div>

        {grouping.items.length > 0 && (
          <div>
            <p role="status" className="font-medium">{t('archive.summary', { items: grouping.items.length, files: picked.length })}</p>
            <ul className="mt-3 space-y-3">
              {grouping.items.map((item) => {
                const outcome = outcomes[item.key];
                return (
                  <li key={item.key} className={cn('card min-w-0 p-4', outcome?.status === 'error' && 'border-critical')}>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <h3 className="me-auto min-w-0 break-words font-medium" dir="auto">{item.displayName}</h3>
                      {item.skipAi ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-sage-wash px-3 py-1 text-sm text-sage">
                          <FileText size={14} aria-hidden /> {t('archive.hasText')}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-primary-wash px-3 py-1 text-sm text-primary-strong">
                          <Sparkles size={14} aria-hidden /> {item.media.every((f) => isVideo(mediaType(f))) ? t('archive.noTextVideo') : t('archive.noText')}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-muted">{t('archive.mediaCount', { count: item.media.length })}</p>
                    <ol className="mt-1 list-decimal ps-6 text-sm">
                      {item.media.map((file) => <li key={file.id} dir="auto" className="break-all">{file.relativePath || file.name}</li>)}
                    </ol>
                    {item.text && <p className="mt-1 text-sm text-muted" dir="auto">{t('archive.textFile', { name: item.text.name })}</p>}
                    {outcome?.status === 'sending' && <p className="mt-2 inline-flex items-center gap-1.5 text-sm text-muted"><Loader2 size={14} className="animate-spin" aria-hidden />{t('bulk.sending')}</p>}
                    {outcome?.status === 'done' && (
                      <p className="mt-2 inline-flex flex-wrap items-center gap-1.5 text-sm text-positive">
                        <CheckCircle2 size={14} aria-hidden />{t('bulk.saved')}
                        {outcome.link && <Link href={outcome.link} className="ms-2 underline underline-offset-2">{t(expert ? 'bulk.openRecord' : 'archive.openReceipt')}</Link>}
                      </p>
                    )}
                    {outcome?.status === 'error' && <p role="alert" className="mt-2 text-sm text-critical">{outcome.error}</p>}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {grouping.skipped.length > 0 && (
          <div className="rounded-lg border border-rule bg-paper-2 p-3 text-sm">
            <p className="font-medium">{t('archive.skipped', { count: grouping.skipped.length })}</p>
            <ul className="mt-1 list-disc ps-6">{grouping.skipped.map((file) => <li key={file.id} dir="auto" className="break-all">{file.relativePath || file.name}</li>)}</ul>
          </div>
        )}
      </section>

      {/* ── 2. for the whole batch ───────────────────────────────────── */}
      <section aria-labelledby={`${id}-batch`} className="space-y-5">
        <h2 id={`${id}-batch`} className="font-display text-2xl">{t('archive.batch')}</h2>
        <fieldset className="space-y-2" disabled={running}>
          <legend className="font-medium">{t('bulk.dating')} <span className="text-critical">*</span></legend>
          <label htmlFor={`${id}-period`} className="block text-sm text-muted">{t('bulk.datingHint')}</label>
          <input id={`${id}-period`} type="text" dir="ltr" inputMode="numeric" placeholder="1952 / 1940-1950"
            className={cn(inputClass, 'max-w-xs', shown('period') && 'border-critical')} value={period}
            disabled={running || periodUnknown} aria-invalid={Boolean(shown('period'))}
            aria-describedby={shown('period') ? `${id}-period-error` : undefined}
            onChange={(e) => setPeriod(e.target.value)} />
          <label className="flex min-h-11 cursor-pointer items-center gap-3">
            <input type="checkbox" className="h-5 w-5 accent-[var(--color-accent-strong)]" checked={periodUnknown}
              onChange={(e) => { setPeriodUnknown(e.target.checked); if (e.target.checked) setPeriod(''); }} />
            {t('bulk.dateUnknown')}
          </label>
          {shown('period') && <p id={`${id}-period-error`} role="alert" className="text-sm text-critical">{shown('period')}</p>}
        </fieldset>

        <fieldset className="space-y-2" disabled={running}>
          <legend id={`${id}-credit-legend`} className="font-medium">{t('bulk.credit')} <span className="text-critical">*</span></legend>
          <div role="radiogroup" aria-labelledby={`${id}-credit-legend`} aria-required="true"
            aria-invalid={Boolean(shown('credit')) || undefined}
            aria-describedby={shown('credit') ? `${id}-credit-error` : undefined} className="flex flex-wrap gap-3">
            {([true, false] as const).map((value) => (
              <label key={String(value)} className={cn('flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-4',
                creditRequired === value ? 'border-accent-strong bg-accent-wash' : 'border-control bg-paper')}>
                <input type="radio" name={`${id}-credit`} className="h-5 w-5 accent-[var(--color-accent-strong)]"
                  checked={creditRequired === value} onChange={() => { setCreditRequired(value); if (!value) setCollectorName(''); }} />
                {t(value ? 'bulk.creditYes' : 'bulk.creditNo')}
              </label>
            ))}
          </div>
          {shown('credit') && <p id={`${id}-credit-error`} role="alert" className="text-sm text-critical">{shown('credit')}</p>}
          {creditRequired && (
            <div className="space-y-1.5">
              <label htmlFor={`${id}-collector`} className="block font-medium">{t('bulk.collector')} <span className="text-critical">*</span></label>
              <input id={`${id}-collector`} type="text" dir="auto" maxLength={200} value={collectorName}
                className={cn(inputClass, shown('collector') && 'border-critical')}
                aria-invalid={Boolean(shown('collector'))} aria-describedby={shown('collector') ? `${id}-collector-error` : undefined}
                onChange={(e) => setCollectorName(e.target.value)} />
              {shown('collector') && <p id={`${id}-collector-error`} role="alert" className="text-sm text-critical">{shown('collector')}</p>}
            </div>
          )}
        </fieldset>

        <div>
          <label className="flex min-h-11 cursor-pointer items-start gap-3">
            <input type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-[var(--color-accent-strong)]" checked={consented} disabled={running}
              aria-invalid={showErrors && !consented ? true : undefined}
              aria-describedby={showErrors && !consented ? `${id}-consent-error` : undefined}
              onChange={(e) => setConsented(e.target.checked)} />
            <span className="text-start">
              {t('bulk.consent')}{' '}
              <Link href="/handling" className="underline underline-offset-2" target="_blank">{t('bulk.consentLink')}</Link>
            </span>
          </label>
          {showErrors && !consented && <p id={`${id}-consent-error`} role="alert" className="text-sm text-critical">{t('bulk.err.consent')}</p>}
        </div>
      </section>

      {/* ── 3. send ──────────────────────────────────────────────────── */}
      <section aria-labelledby={`${id}-send`} className="card space-y-4 p-5">
        <h2 id={`${id}-send`} className="font-display text-xl">{t('bulk.submitHeading')}</h2>
        {progress && (
          <div role="status" aria-live="polite" className="space-y-2">
            <p className="font-medium">{t('bulk.progress', { index: progress.index, total: progress.total })}</p>
            <div className="h-3 w-full overflow-hidden rounded-full bg-paper-2" aria-hidden>
              <div className="h-full rounded-full bg-accent-strong transition-[width]" style={{ width: `${(progress.index / progress.total) * 100}%` }} />
            </div>
          </div>
        )}
        {!running && done > 0 && (
          <p role="status" className="text-sm">
            {t('bulk.summary', { done, total: grouping.items.length })}
            {failed > 0 && <> {t('bulk.summaryFailed', { count: failed })}</>}
          </p>
        )}
        <div className="flex flex-wrap items-start gap-4">
          <button type="button" onClick={submit} disabled={running || !pendingItems.length}
            aria-describedby={grouping.orphanTextFiles.length ? orphanId : undefined} className={buttonClass('primary')}>
            {running && <Loader2 size={18} className="animate-spin" aria-hidden />}
            {failed > 0 && !running ? t('bulk.retryFailed', { count: pendingItems.length }) : t('archive.upload', { count: pendingItems.length })}
          </button>
          {/* Beside the button on purpose: the moment someone is about to send is the moment to say what will be left out. */}
          {grouping.orphanTextFiles.length > 0 && (
            <div id={orphanId} role="alert" className="min-w-0 flex-1 rounded-lg border-s-4 border-critical bg-critical/8 px-3 py-2 text-sm text-critical">
              <p className="flex items-center gap-1.5 font-medium"><AlertTriangle size={16} aria-hidden /> {t('archive.orphans', { count: grouping.orphanTextFiles.length })}</p>
              <ul className="mt-1 list-disc ps-6">{grouping.orphanTextFiles.map((file) => <li key={file.id} dir="auto" className="break-all">{file.relativePath || file.name}</li>)}</ul>
            </div>
          )}
        </div>
        <p className="text-sm text-muted">{t(expert ? 'archive.afterExpert' : 'archive.afterWindow')}</p>
      </section>
    </div>
  );
}
