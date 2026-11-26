'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { GripVertical, X, Loader2, ExternalLink } from 'lucide-react';
import { useMessages } from '@/lib/i18n/provider';
import { COMMUNITIES, type Community } from '@/lib/types';
import { communityKey } from '@/lib/i18n/labels';
import { CONSENT_VERSION } from '@/lib/consent';
import { youtubeVideoId, youtubeThumbnailUrl } from '@/lib/links/youtube';
import { uploadSignedFile } from '@/lib/files/upload';
import { uploadSignBody } from '@/lib/files/hash';
import { validateFile } from '@/lib/files/validate';
import { cn } from '@/lib/utils';
import { buttonClass } from '@/components/primitives';

const inputClass = 'h-11 w-full rounded-lg border border-control bg-paper px-3 focus:border-accent-strong';

type UploadedImage = {
  id: string;
  file: File;
  previewUrl: string;
  storagePath: string;
  grant: string;
  expiresAt: number;
  byteSize: number;
  width: number | null;
  height: number | null;
};

type Step = 'details' | 'consent';

export function RecordingUploadFlow() {
  const t = useMessages();
  const router = useRouter();
  const [step, setStep] = useState<Step>('details');
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [community, setCommunity] = useState<string>('');
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const dragOver = useRef<number | null>(null);
  const lastFetchedId = useRef<string | null>(null);

  const videoId = youtubeVideoId(url);
  const urlValid = url.length === 0 || videoId !== null;

  // Auto-fill title from YouTube oEmbed when a valid video ID is detected.
  useEffect(() => {
    if (!videoId || videoId === lastFetchedId.current) return;
    lastFetchedId.current = videoId;
    fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`)
      .then((r) => r.json())
      .then((data) => {
        if (typeof data.title === 'string' && data.title.trim()) {
          setTitle((prev) => prev.trim() ? prev : data.title.trim());
        }
      })
      .catch(() => { /* silently ignore — user can fill title manually */ });
  }, [videoId]);
  const canContinue = videoId !== null && title.trim().length > 0;

  async function handleImagePick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!files.length) return;

    setUploadingImage(true);
    setUploadError(null);

    for (const file of files) {
      const rejection = validateFile({ mimeType: file.type, byteSize: file.size });
      if (rejection) {
        setUploadError(rejection.message);
        setUploadingImage(false);
        return;
      }
      if (!file.type.startsWith('image/')) {
        setUploadError(t('upload.recording.imagesLabel') + ': images only');
        setUploadingImage(false);
        return;
      }
    }

    try {
      const uploaded: UploadedImage[] = [];
      for (const file of files) {
        const signRes = await fetch('/api/uploads/sign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(await uploadSignBody(file)),
        });
        const signed = await signRes.json().catch(() => null);
        if (!signed?.ok) throw new Error(signed?.error?.message ?? 'Upload failed');

        const { error } = await uploadSignedFile(signed.data.path, signed.data.token, file);
        if (error) throw new Error(error.message);

        const previewUrl = URL.createObjectURL(file);

        uploaded.push({
          id: crypto.randomUUID(),
          file,
          previewUrl,
          storagePath: signed.data.path,
          grant: signed.data.grant,
          expiresAt: signed.data.expiresAt,
          byteSize: file.size,
          width: null,
          height: null,
        });
      }
      setImages((prev) => [...prev, ...uploaded]);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploadingImage(false);
    }
  }

  function removeImage(id: string) {
    setImages((prev) => prev.filter((img) => img.id !== id));
  }

  function handleDragStart(index: number) {
    dragOver.current = index;
  }

  function handleDragEnter(index: number) {
    if (dragOver.current === null || dragOver.current === index) return;
    setImages((prev) => {
      const next = [...prev];
      const [moved] = next.splice(dragOver.current!, 1);
      next.splice(index, 0, moved);
      dragOver.current = index;
      return next;
    });
  }

  async function handleSubmit() {
    if (!canContinue) return;
    setSubmitting(true);
    setSubmitError(null);

    try {
      const res = await fetch('/api/items/recording', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          sourceUrl: url.trim(),
          community: community || null,
          consentVersion: CONSENT_VERSION,
          files: images.map((img) => ({
            path: img.storagePath,
            fileName: img.file.name,
            mimeType: img.file.type,
            byteSize: img.byteSize,
            width: img.width,
            height: img.height,
            grant: img.grant,
            expiresAt: img.expiresAt,
          })),
        }),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error?.message ?? 'Submission failed');
      }

      router.push(`/review/${data.data.id}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Submission failed');
      setSubmitting(false);
    }
  }

  if (step === 'consent') {
    return (
      <div className="mx-auto w-full max-w-xl space-y-6">
        <h2 className="font-display text-2xl">{t('upload.recording.step.consent')}</h2>

        <div className="card space-y-3 p-5 text-sm text-muted">
          <p>
            By submitting this recording you confirm that you have the right to share
            it with the Indian Jewish Heritage Center archive, and that the information
            you have provided is accurate to the best of your knowledge.
          </p>
          <p>
            The recording will be reviewed by a content expert before it is published.
          </p>
        </div>

        {submitError && (
          <p role="alert" className="text-sm text-red-600">{submitError}</p>
        )}

        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => setStep('details')}
            className={buttonClass('quiet')}
            disabled={submitting}
          >
            {t('guides.back')}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className={buttonClass('primary')}
          >
            {submitting && <Loader2 size={16} className="animate-spin" aria-hidden />}
            {submitting ? t('upload.recording.submitting') : t('upload.recording.submit')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-xl space-y-6">
      <h2 className="font-display text-2xl">{t('upload.recording.step.details')}</h2>

      {/* YouTube URL */}
      <div className="space-y-1.5">
        <label className="block font-medium" htmlFor="rec-url">
          {t('upload.recording.urlLabel')}
        </label>
        <p id="rec-url-hint" className="text-sm text-muted">{t('upload.recording.urlHint')}</p>
        <input
          id="rec-url"
          aria-invalid={url.length > 0 && !urlValid ? true : undefined}
          aria-describedby={url.length > 0 && !urlValid ? 'rec-url-hint rec-url-error' : 'rec-url-hint'}
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className={cn(
            inputClass,
            url.length > 0 && !urlValid && 'border-red-400 focus:border-red-400',
          )}
          placeholder="https://www.youtube.com/watch?v=…"
          dir="ltr"
        />
        {url.length > 0 && !urlValid && (
          <p id="rec-url-error" role="alert" className="text-sm text-critical">{t('upload.recording.urlInvalid')}</p>
        )}
      </div>

      {/* Thumbnail preview */}
      {videoId && (
        <div className="overflow-hidden rounded-xl bg-surface-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={youtubeThumbnailUrl(videoId)}
            alt=""
            className="aspect-video w-full object-cover"
          />
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted">
            <ExternalLink size={12} aria-hidden />
            <a href={url} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-1 hover:text-accent-strong">
              {url}
            </a>
          </div>
        </div>
      )}

      {/* Title */}
      <div className="space-y-1.5">
        <label className="block font-medium" htmlFor="rec-title">
          {t('upload.recording.titleLabel')}
        </label>
        <input
          id="rec-title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className={inputClass}
          maxLength={200}
        />
      </div>

      {/* Community */}
      <div className="space-y-1.5">
        <label className="block font-medium" htmlFor="rec-community">
          {t('upload.recording.communityLabel')}
        </label>
        <select
          id="rec-community"
          value={community}
          onChange={(e) => setCommunity(e.target.value)}
          className={inputClass}
        >
          <option value="">—</option>
          {COMMUNITIES.map((c) => (
            <option key={c} value={c}>{t(communityKey(c as Community))}</option>
          ))}
        </select>
      </div>

      {/* Invitation images */}
      <div className="space-y-2">
        <div>
          <span className="block font-medium">{t('upload.recording.imagesLabel')}</span>
          <p className="text-sm text-muted">{t('upload.recording.imagesHint')}</p>
        </div>

        {images.length > 0 && (
          <ul className="space-y-2">
            {images.map((img, index) => (
              <li
                key={img.id}
                draggable
                onDragStart={() => handleDragStart(index)}
                onDragEnter={() => handleDragEnter(index)}
                onDragOver={(e) => e.preventDefault()}
                className="flex items-center gap-3 rounded-lg border border-rule bg-paper p-2"
              >
                <GripVertical size={16} className="shrink-0 cursor-grab text-muted" aria-hidden />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.previewUrl} alt="" className="h-12 w-12 rounded object-cover" />
                <span className="min-w-0 flex-1 truncate text-sm">{img.file.name}</span>
                {index === 0 && (
                  <span className="eyebrow shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[0.65rem] text-accent">
                    default
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => removeImage(img.id)}
                  aria-label={`Remove ${img.file.name}`}
                  className="shrink-0 text-muted hover:text-foreground"
                >
                  <X size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {uploadError && (
          <p role="alert" className="text-sm text-red-600">{uploadError}</p>
        )}

        <label
          className={cn(
            buttonClass('quiet', 'cursor-pointer'),
            uploadingImage && 'pointer-events-none opacity-50',
          )}
        >
          {uploadingImage && <Loader2 size={14} className="animate-spin" aria-hidden />}
          {t('upload.step.files')}
          <input
            type="file"
            accept="image/*"
            multiple
            className="sr-only"
            onChange={handleImagePick}
            disabled={uploadingImage}
          />
        </label>
      </div>

      <button
        type="button"
        disabled={!canContinue}
        onClick={() => setStep('consent')}
        className={buttonClass('primary')}
      >
        {t('flow.next')}
      </button>
    </div>
  );
}
