'use client';
import { usePathname } from 'next/navigation';
import type { SyntheticEvent } from 'react';

/**
 * Pages that show published media to the public: the portal, every record,
 * and the home page's "Recently added" cards. Right-click, drag and text
 * selection are discouraged there (screenshots cannot be blocked on the web).
 */
export function isPublicMediaPath(path: string | null) {
  return path === '/' || path === '/portal' || Boolean(path?.startsWith('/portal/'));
}
export function usePublicMedia() {
  const protectedView = isPublicMediaPath(usePathname());
  const prevent = (event: SyntheticEvent) => event.preventDefault();
  return {
    protectedView,
    props: protectedView ? {
      onContextMenu: prevent, onDragStart: prevent, draggable: false,
      'data-public-media': true,
      style: { userSelect: 'none' as const, WebkitUserSelect: 'none' as const },
    } : {},
  };
}
