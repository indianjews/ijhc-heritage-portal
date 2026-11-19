'use client';

import { ExternalLink } from 'lucide-react';
import { youtubeVideoId, youtubeEmbedUrl } from '@/lib/links/youtube';
import { useMessages } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';

/**
 * Embeds a YouTube video using the privacy-enhanced player (youtube-nocookie.com).
 *
 * No cookies are set until the visitor presses play. The CSP allows this
 * origin explicitly (src/proxy.ts).
 *
 * Falls back to a plain external link when the URL cannot be parsed.
 */
export function YouTubeEmbed({ url, title, className }: { url: string; title: string; className?: string }) {
  const t = useMessages();
  const videoId = youtubeVideoId(url);

  if (!videoId) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-2 text-accent underline underline-offset-2"
      >
        <ExternalLink size={16} aria-hidden />
        {t('record.watchRecording')}
      </a>
    );
  }

  return (
    <div className={cn('aspect-video w-full overflow-hidden rounded-xl bg-surface-2', className)}>
      <iframe
        src={youtubeEmbedUrl(videoId)}
        title={title}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        className="h-full w-full border-0"
      />
    </div>
  );
}
