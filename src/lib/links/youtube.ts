// Inline the YouTube host list to avoid importing policy.ts, which pulls in
// node:net (via isIP) and cannot be bundled for the browser.
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'www.youtu.be',
]);

/**
 * Extract the 11-character video ID from any recognised YouTube URL.
 *
 * Handles the common forms:
 *   https://www.youtube.com/watch?v=XXXXXXXXXXX
 *   https://youtu.be/XXXXXXXXXXX
 *   https://www.youtube.com/embed/XXXXXXXXXXX
 *   https://www.youtube.com/shorts/XXXXXXXXXXX
 *   https://m.youtube.com/watch?v=XXXXXXXXXXX
 *
 * Returns null if the host is not a recognised YouTube host or if no video ID
 * can be found.
 */
export function youtubeVideoId(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }

  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;

  // youtu.be/XXXXXXXXXXX
  if (url.hostname === 'youtu.be' || url.hostname === 'www.youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return isValidId(id) ? id : null;
  }

  // /watch?v=
  const v = url.searchParams.get('v');
  if (v && isValidId(v)) return v;

  // /embed/XXXXXXXXXXX  or  /shorts/XXXXXXXXXXX  or  /v/XXXXXXXXXXX
  const pathParts = url.pathname.split('/').filter(Boolean);
  const prefixes = ['embed', 'shorts', 'v'];
  for (let i = 0; i < pathParts.length - 1; i++) {
    if (prefixes.includes(pathParts[i])) {
      const id = pathParts[i + 1];
      if (isValidId(id)) return id;
    }
  }

  return null;
}

/** True for the standard 11-char Base64url video ID YouTube uses. */
function isValidId(id: string): boolean {
  return /^[A-Za-z0-9_-]{11}$/.test(id);
}

/**
 * The privacy-enhanced embed URL for a video ID.
 *
 * youtube-nocookie.com does not set tracking cookies until the visitor
 * actually presses play. This is the standard recommendation for embeds
 * where consent has not been explicitly collected.
 */
export function youtubeEmbedUrl(videoId: string): string {
  return `https://www.youtube-nocookie.com/embed/${videoId}`;
}

/**
 * The highest-resolution thumbnail YouTube offers for a video.
 * Used for preview during upload and as a fallback when the embed cannot load.
 */
export function youtubeThumbnailUrl(videoId: string): string {
  return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
}
