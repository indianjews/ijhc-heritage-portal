'use client';

import Link from 'next/link';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Loader2, Plus, Trash2, Copy, CheckCircle2, AlertCircle } from 'lucide-react';
import { Dropzone } from '@/components/dropzone';
import { buttonClass } from '@/components/primitives';
import { useMessages } from '@/lib/i18n/provider';
import type { MessageKey } from '@/lib/i18n/messages';
import { uploadSignBody } from '@/lib/files/hash';
import { uploadSignedFile } from '@/lib/files/upload';
import { measureDuration } from '@/lib/files/measure';
import { validateFile } from '@/lib/files/validate';
import { youtubeVideoId } from '@/lib/links/youtube';
import { BULK_ACCEPT, bulkFileAccepted, cardErrors, type CardErrorKey, type CardField } from '@/lib/items/bulk-upload';
import { cn } from '@/lib/utils';

/**
 * A content expert's bulk upload: many items, each with its media, notes,
 * dating and copyright, sent one at a time.
 *
 * ── one at a time, on purpose ───────────────────────────────────────────────
 *
 * Each item's files go straight to storage through /api/uploads/sign (the
 * same signed, granted path every upload uses), then the item is created by
 * /api/items/bulk-upload-item. One request per item means a batch of forty
 * never meets the platform's time limit, and a failure costs one card, not
 * the batch: the card keeps everything typed and can be sent again on its own.
 *
 * Nothing here calls the model. The server queues each image's reading for the
 * quiet-hours cron (images and PDFs; never videos), so an expert never waits for Gemini and never spends the
 * daily allowance that live contributors need.
 *
 * ── the field order is the point ────────────────────────────────────────────
 *
 * Media first, so it is clear what each card is about; then notes; then the
 * two answers the archive requires — dating (or "unknown") and copyright
 * (yes/no, no default). The same rules the server enforces are checked here
 * from `cardErrors`, so the button and the route cannot disagree.
 */

/** A grant this close to expiry is not trusted for a retry; the file is uploaded again. */
const GRANT_MARGIN_MS = 5 * 60_000;

interface LocalFile {
  id: string;
  file: File;
  uploaded?: { path: string; grant: string; expiresAt: number; durationMs: number | null };
}

type CardStatus = 'draft' | 'sending' | 'done' | 'error';

interface Card {
  key: string;
  collapsed: boolean;
  files: LocalFile[];
  youtubeUrl: string;
  youtubeTitle: string;
  description: string;
  period: string;
  periodUnknown: boolean;
  creditRequired: boolean | null;
  collectorName: string;
  status: CardStatus;
  /** A message key (bulk.err.*, err.*) or text from the server. */
  error?: string;
  /** Field errors the server returned, as message keys. */
  serverFields?: Record<string, string>;
  itemId?: string;
  itemTitle?: string;
  showErrors: boolean;
  fileError?: string;
}

function emptyCard(): Card {
  return {
    key: crypto.randomUUID(), collapsed: false, files: [], youtubeUrl: '', youtubeTitle: '', description: '',
    period: '', periodUnknown: false, creditRequired: null, collectorName: '', status: 'draft', showErrors: false,
  };
}

function hasContent(card: Card): boolean {
  return Boolean(card.files.length || card.youtubeUrl.trim() || card.description.trim() || card.period.trim()
    || card.periodUnknown || card.creditRequired !== null || card.collectorName.trim());
}

function errorsOf(card: Card) {
  return cardErrors({
    fileCount: card.files.length,
    youtubeUrl: card.youtubeUrl,
    period: card.period,
    periodUnknown: card.periodUnknown,
    creditRequired: card.creditRequired,
    collectorName: card.collectorName,
  });
}

const inputClass = 'min-h-11 w-full rounded-lg border border-control bg-paper px-3 py-2 text-start focus:border-accent-strong';

export function BulkUploadFlow({ consentVersion }: { consentVersion: string }) {
  const t = useMessages();
  const [cards, setCards] = useState<Card[]>(() => [emptyCard()]);
  const [consented, setConsented] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ index: number; total: number } | null>(null);
  const [showConsentError, setShowConsentError] = useState(false);

  /** A key from the catalogue, or a server sentence shown as it came. */
  const say = (value: string | undefined): string => {
    if (!value) return '';
    try {
      const text = t(value as MessageKey);
      return text && text !== value ? text : value;
    } catch {
      return value;
    }
  };

  const unsent = cards.some((card) => card.status !== 'done' && hasContent(card));
  useEffect(() => {
    if (!unsent && !running) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsent, running]);

  function update(key: string, patch: Partial<Card>) {
    setCards((previous) => previous.map((card) => (card.key === key ? { ...card, ...patch } : card)));
  }

  function addCard() {
    setCards((previous) => [...previous.map((c) => (c.status === 'done' ? c : { ...c, collapsed: hasContent(c) ? c.collapsed : false })), emptyCard()]);
  }

  function removeCard(key: string) {
    const card = cards.find((c) => c.key === key);
    if (card && hasContent(card) && !window.confirm(t('bulk.removeConfirm'))) return;
    setCards((previous) => (previous.length > 1 ? previous.filter((c) => c.key !== key) : [emptyCard()]));
  }

  function applyToAll(source: Card) {
    setCards((previous) => previous.map((card) => (card.key === source.key || card.status === 'done' ? card : {
      ...card,
      period: source.period,
      periodUnknown: source.periodUnknown,
      creditRequired: source.creditRequired,
      collectorName: source.collectorName,
    })));
  }

  const pending = cards.filter((card) => card.status !== 'done');
  const failed = cards.filter((card) => card.status === 'error').length;
  const done = cards.length - pending.length;

  async function sendOne(card: Card): Promise<Partial<Card>> {
    // 1. Files to storage, reusing an earlier upload when its grant is still good.
    const files: LocalFile[] = [];
    for (const local of card.files) {
      if (local.uploaded && local.uploaded.expiresAt - Date.now() > GRANT_MARGIN_MS) {
        files.push(local);
        continue;
      }
      const signResponse = await fetch('/api/uploads/sign', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(await uploadSignBody(local.file)),
      });
      const signed = await signResponse.json().catch(() => null);
      if (!signed?.ok) throw new Error(signed?.error?.message ?? 'bulk.err.upload');
      const { error } = await uploadSignedFile(signed.data.path, signed.data.token, local.file);
      if (error) throw new Error('bulk.err.upload');
      files.push({
        ...local,
        uploaded: { path: signed.data.path, grant: signed.data.grant, expiresAt: signed.data.expiresAt, durationMs: await measureDuration(local.file) },
      });
    }
    // Keep the uploads, so a failure below does not cost the bytes again.
    update(card.key, { files });

    // 2. The item.
    const response = await fetch('/api/items/bulk-upload-item', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: card.description.trim() || undefined,
        youtubeUrl: card.youtubeUrl.trim() || undefined,
        youtubeTitle: card.youtubeTitle.trim() || undefined,
        period: card.periodUnknown ? undefined : card.period.trim(),
        periodUnknown: card.periodUnknown,
        creditRequired: card.creditRequired,
        collectorName: card.creditRequired ? card.collectorName.trim() : undefined,
        consentVersion,
        files: files.map((f) => ({
          path: f.uploaded!.path, grant: f.uploaded!.grant, expiresAt: f.uploaded!.expiresAt,
          fileName: f.file.name, mimeType: f.file.type, byteSize: f.file.size, durationMs: f.uploaded!.durationMs,
        })),
      }),
    });
    const result = await response.json().catch(() => null);
    if (!result?.ok) {
      return { status: 'error', error: result?.error?.message ?? 'bulk.err.failed', serverFields: result?.error?.fields, files, showErrors: true };
    }
    return { status: 'done', collapsed: true, itemId: result.data.id, itemTitle: result.data.title, error: undefined, serverFields: undefined, files };
  }

  async function submitAll() {
    if (running) return;
    const toSend = cards.filter((card) => card.status !== 'done');
    const invalidCards = toSend.filter((card) => Object.keys(errorsOf(card)).length > 0);
    if (!consented) setShowConsentError(true);
    if (invalidCards.length || !consented) {
      setCards((previous) => previous.map((card) => (card.status === 'done' ? card : { ...card, showErrors: true, collapsed: Object.keys(errorsOf(card)).length ? false : card.collapsed })));
      return;
    }

    setRunning(true);
    try {
      for (let index = 0; index < toSend.length; index++) {
        const card = toSend[index];
        setProgress({ index: index + 1, total: toSend.length });
        update(card.key, { status: 'sending', error: undefined, serverFields: undefined });
        try {
          update(card.key, await sendOne(card));
        } catch (error) {
          update(card.key, { status: 'error', error: error instanceof Error ? error.message : 'bulk.err.failed' });
        }
      }
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  return (
    <div className="space-y-6">
      <ol className="space-y-5">
        {cards.map((card, index) => (
          <li key={card.key}>
            <ItemCard
              card={card}
              number={index + 1}
              disabled={running || card.status === 'done' || card.status === 'sending'}
              canRemove={!running && card.status !== 'done'}
              update={(patch) => update(card.key, patch)}
              remove={() => removeCard(card.key)}
              applyToAll={() => applyToAll(card)}
              others={cards.length > 1}
              say={say}
            />
          </li>
        ))}
      </ol>

      <button type="button" onClick={addCard} disabled={running} className={buttonClass('quiet', 'w-full sm:w-auto')}>
        <Plus size={18} aria-hidden /> {t('bulk.addItem')}
      </button>

      <section className="card space-y-4 p-5" aria-labelledby="bulk-submit-heading">
        <h2 id="bulk-submit-heading" className="font-display text-xl">{t('bulk.submitHeading')}</h2>
        <label className="flex min-h-11 cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            className="mt-1 h-5 w-5 shrink-0 accent-[var(--color-accent-strong)]"
            checked={consented}
            disabled={running}
            onChange={(e) => { setConsented(e.target.checked); setShowConsentError(false); }}
          />
          <span className="text-start">
            {t('bulk.consent')}{' '}
            <Link href="/handling" className="underline underline-offset-2" target="_blank">{t('bulk.consentLink')}</Link>
          </span>
        </label>
        {showConsentError && !consented && <p role="alert" className="text-sm text-critical">{t('bulk.err.consent')}</p>}

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
            {t('bulk.summary', { done, total: cards.length })}
            {failed > 0 && <> {t('bulk.summaryFailed', { count: failed })}</>}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={submitAll} disabled={running || pending.length === 0} className={buttonClass('primary')}>
            {running && <Loader2 size={18} className="animate-spin" aria-hidden />}
            {failed > 0 && !running ? t('bulk.retryFailed', { count: pending.length }) : t('bulk.submitAll', { count: pending.length })}
          </button>
          {done > 0 && !running && <Link href="/review" className={buttonClass('quiet')}>{t('bulk.toQueue')}</Link>}
        </div>
        <p className="text-sm text-muted">{t('bulk.queuedNote')}</p>
      </section>
    </div>
  );
}

function ItemCard({ card, number, disabled, canRemove, update, remove, applyToAll, others, say }: {
  card: Card;
  number: number;
  disabled: boolean;
  canRemove: boolean;
  update: (patch: Partial<Card>) => void;
  remove: () => void;
  applyToAll: () => void;
  others: boolean;
  say: (value: string | undefined) => string;
}) {
  const t = useMessages();
  const id = useId();
  const lastFetched = useRef<string | null>(null);
  const errors = useMemo(() => errorsOf(card), [card]);
  const shown = (field: CardField): string | undefined => {
    const server = card.serverFields?.[field === 'collector' ? 'collectorName' : field];
    if (server) return say(server);
    const key: CardErrorKey | undefined = card.showErrors ? errors[field] : undefined;
    return key ? t(key) : undefined;
  };

  // Shown as soon as a non-YouTube address is typed, not only after Send.
  const youtubeError = shown('youtube') ?? (card.youtubeUrl.trim() && errors.youtube ? t('bulk.err.youtube') : undefined);

  // The video's own title, as a title candidate only (the same call the recording upload makes).
  const videoId = youtubeVideoId(card.youtubeUrl);
  useEffect(() => {
    if (!videoId || videoId === lastFetched.current) return;
    lastFetched.current = videoId;
    fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`)
      .then((r) => r.json())
      .then((data) => { if (typeof data.title === 'string') update({ youtubeTitle: data.title.trim().slice(0, 200) }); })
      .catch(() => { /* a title is a convenience; the item can be sent without it */ });
  }, [videoId, update]);

  function pick(event: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = '';
    addFiles(picked);
  }

  /** The one way in, for the button and for a drop alike: the same allow-list, size check and message. */
  function addFiles(picked: File[]) {
    const refused = picked.find((file) => !bulkFileAccepted(file.type) || validateFile({ mimeType: file.type, byteSize: file.size }));
    if (refused) {
      const rejection = validateFile({ mimeType: refused.type, byteSize: refused.size });
      update({ fileError: rejection?.code === 'too_large' ? t('bulk.err.fileSize', { name: refused.name }) : t('bulk.err.fileType', { name: refused.name }) });
    } else {
      update({ fileError: undefined });
    }
    const accepted = picked.filter((file) => bulkFileAccepted(file.type) && !validateFile({ mimeType: file.type, byteSize: file.size }));
    if (accepted.length) update({ files: [...card.files, ...accepted.map((file) => ({ id: crypto.randomUUID(), file }))].slice(0, 25) });
  }

  const label = card.itemTitle || card.description.split('\n')[0]?.trim() || card.files[0]?.file.name || '';
  const statusLine = card.status === 'done'
    ? <span className="inline-flex items-center gap-1.5 text-sm text-accent-strong"><CheckCircle2 size={16} aria-hidden />{t('bulk.saved')}</span>
    : card.status === 'sending'
      ? <span className="inline-flex items-center gap-1.5 text-sm text-muted"><Loader2 size={16} className="animate-spin" aria-hidden />{t('bulk.sending')}</span>
      : card.status === 'error'
        ? <span className="inline-flex items-center gap-1.5 text-sm text-critical"><AlertCircle size={16} aria-hidden />{t('bulk.failed')}</span>
        : null;

  return (
    <article className={cn('card min-w-0 p-4 sm:p-6', card.status === 'error' && 'border-critical')} aria-labelledby={`${id}-heading`}>
      <header className="flex flex-wrap items-center gap-3">
        <h2 id={`${id}-heading`} className="me-auto min-w-0 font-display text-xl">
          {t('bulk.itemNumber', { number })}
          {label && card.collapsed && <span className="ms-2 break-words text-base text-muted" dir="auto">{label}</span>}
        </h2>
        {statusLine}
        <button
          type="button"
          className={buttonClass('quiet', 'w-11 px-0')}
          aria-expanded={!card.collapsed}
          aria-controls={`${id}-body`}
          aria-label={card.collapsed ? t('bulk.expand') : t('bulk.collapse')}
          onClick={() => update({ collapsed: !card.collapsed })}
        >
          {card.collapsed ? <ChevronDown size={18} aria-hidden /> : <ChevronUp size={18} aria-hidden />}
        </button>
        {canRemove && (
          <button type="button" className={buttonClass('quiet', 'w-11 px-0')} aria-label={t('bulk.remove')} onClick={remove}>
            <Trash2 size={18} aria-hidden />
          </button>
        )}
      </header>

      {card.status === 'error' && card.error && <p role="alert" className="mt-3 text-sm text-critical">{say(card.error)}</p>}
      {card.status === 'done' && card.itemId && (
        <p className="mt-3 text-sm">
          <Link href={`/review/${card.itemId}`} className="underline underline-offset-2">{t('bulk.openRecord')}</Link>
        </p>
      )}

      <div id={`${id}-body`} hidden={card.collapsed} className="mt-5 space-y-6">
        {/* 1. Media */}
        <fieldset className="space-y-3" disabled={disabled} aria-describedby={shown('media') ? `${id}-media-error` : undefined}>
          <legend className="font-medium">{t('bulk.media')} <span className="text-critical">*</span></legend>
          <p className="text-sm text-muted">{t('bulk.mediaHint')}</p>
          <Dropzone prompt={t('bulk.dropPrompt')} disabled={disabled} onFiles={(dropped) => addFiles(dropped.map((d) => d.file))}>
            <label className={buttonClass('quiet', 'cursor-pointer')}>
              <Plus size={18} aria-hidden /> {t('bulk.chooseFiles')}
              <input type="file" multiple accept={BULK_ACCEPT} className="sr-only" onChange={pick} />
            </label>
          </Dropzone>
          {card.fileError && <p role="alert" className="text-sm text-critical">{card.fileError}</p>}
          {card.files.length > 0 && (
            <ul className="space-y-2">
              {card.files.map((local) => (
                <li key={local.id} className="flex min-h-11 items-center gap-3 rounded-lg bg-paper-2 px-3">
                  <span className="min-w-0 flex-1 truncate text-start" dir="auto">{local.file.name}</span>
                  {/* ltr: otherwise RTL reorders it to "MB 2.4". */}
                  <span className="shrink-0 text-sm text-muted" dir="ltr">{(local.file.size / 1e6).toFixed(1)} MB</span>
                  {!disabled && (
                    <button
                      type="button"
                      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-surface"
                      aria-label={t('bulk.removeFile', { name: local.file.name })}
                      onClick={() => update({ files: card.files.filter((f) => f.id !== local.id) })}
                    >
                      <Trash2 size={16} aria-hidden />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="space-y-1.5">
            <label htmlFor={`${id}-youtube`} className="block font-medium">{t('bulk.youtube')}</label>
            <p id={`${id}-youtube-hint`} className="text-sm text-muted">{t('bulk.youtubeHint')}</p>
            <input
              id={`${id}-youtube`}
              type="url"
              dir="ltr"
              inputMode="url"
              className={cn(inputClass, shown('youtube') && 'border-critical')}
              placeholder="https://www.youtube.com/watch?v=…"
              value={card.youtubeUrl}
              aria-describedby={[`${id}-youtube-hint`, youtubeError ? `${id}-youtube-error` : ''].filter(Boolean).join(' ')}
              aria-invalid={Boolean(youtubeError)}
              onChange={(e) => update({ youtubeUrl: e.target.value, youtubeTitle: '' })}
            />
            {/* The YouTube rule is shown as soon as a non-YouTube address is typed. */}
            {youtubeError && <p id={`${id}-youtube-error`} role="alert" className="text-sm text-critical">{youtubeError}</p>}
          </div>
          {shown('media') && <p id={`${id}-media-error`} role="alert" className="text-sm text-critical">{shown('media')}</p>}
        </fieldset>

        {/* 2. Notes */}
        <div className="space-y-1.5">
          <label htmlFor={`${id}-description`} className="block font-medium">{t('bulk.description')}</label>
          <p id={`${id}-description-hint`} className="text-sm text-muted">{t('bulk.descriptionHint')}</p>
          <textarea
            id={`${id}-description`}
            dir="auto"
            rows={4}
            maxLength={4000}
            disabled={disabled}
            className={cn(inputClass, 'min-h-28')}
            value={card.description}
            aria-describedby={`${id}-description-hint`}
            onChange={(e) => update({ description: e.target.value })}
          />
        </div>

        {/* 3. Dating */}
        <fieldset className="space-y-2" disabled={disabled}>
          <legend className="font-medium">{t('bulk.dating')} <span className="text-critical">*</span></legend>
          <label htmlFor={`${id}-period`} className="block text-sm text-muted">{t('bulk.datingHint')}</label>
          <input
            id={`${id}-period`}
            type="text"
            dir="ltr"
            inputMode="numeric"
            placeholder="1952 / 1940-1950"
            className={cn(inputClass, 'max-w-xs', shown('period') && 'border-critical')}
            value={card.period}
            disabled={disabled || card.periodUnknown}
            aria-invalid={Boolean(shown('period'))}
            aria-describedby={shown('period') ? `${id}-period-error` : undefined}
            onChange={(e) => update({ period: e.target.value })}
          />
          <label className="flex min-h-11 cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              className="h-5 w-5 accent-[var(--color-accent-strong)]"
              checked={card.periodUnknown}
              onChange={(e) => update({ periodUnknown: e.target.checked, period: e.target.checked ? '' : card.period })}
            />
            {t('bulk.dateUnknown')}
          </label>
          {shown('period') && <p id={`${id}-period-error`} role="alert" className="text-sm text-critical">{shown('period')}</p>}
        </fieldset>

        {/* 4. Copyright */}
        <fieldset className="space-y-2" disabled={disabled}>
          <legend id={`${id}-credit-legend`} className="font-medium">{t('bulk.credit')} <span className="text-critical">*</span></legend>
          <div role="radiogroup" aria-labelledby={`${id}-credit-legend`} aria-required="true"
            aria-invalid={Boolean(shown('credit')) || undefined}
            aria-describedby={shown('credit') ? `${id}-credit-error` : undefined} className="flex flex-wrap gap-3">
            {([true, false] as const).map((value) => (
              <label key={String(value)} className={cn('flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-4',
                card.creditRequired === value ? 'border-accent-strong bg-accent-wash' : 'border-rule-strong bg-paper')}>
                <input
                  type="radio"
                  name={`${id}-credit`}
                  className="h-5 w-5 accent-[var(--color-accent-strong)]"
                  checked={card.creditRequired === value}
                  onChange={() => update({ creditRequired: value, collectorName: value ? card.collectorName : '' })}
                />
                {t(value ? 'bulk.creditYes' : 'bulk.creditNo')}
              </label>
            ))}
          </div>
          {shown('credit') && <p id={`${id}-credit-error`} role="alert" className="text-sm text-critical">{shown('credit')}</p>}
          {card.creditRequired && (
            <div className="space-y-1.5">
              <label htmlFor={`${id}-collector`} className="block font-medium">{t('bulk.collector')} <span className="text-critical">*</span></label>
              <input
                id={`${id}-collector`}
                type="text"
                dir="auto"
                maxLength={200}
                className={cn(inputClass, shown('collector') && 'border-critical')}
                value={card.collectorName}
                aria-invalid={Boolean(shown('collector'))}
                aria-describedby={shown('collector') ? `${id}-collector-error` : undefined}
                onChange={(e) => update({ collectorName: e.target.value })}
              />
              {shown('collector') && <p id={`${id}-collector-error`} role="alert" className="text-sm text-critical">{shown('collector')}</p>}
            </div>
          )}
        </fieldset>

        {others && !disabled && (
          <button type="button" className={buttonClass('quiet', undefined, 'sm')} onClick={applyToAll}>
            <Copy size={16} aria-hidden /> {t('bulk.applyToAll')}
          </button>
        )}
      </div>
    </article>
  );
}
