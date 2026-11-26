'use client';

import { useRef, useState, type ReactNode } from 'react';
import { CloudUpload } from 'lucide-react';
import { useMessages } from '@/lib/i18n/provider';
import { dragHasFiles, readDroppedFiles, type DroppedFile } from '@/lib/upload/drop';
import { cn } from '@/lib/utils';

/**
 * A place to drop files, around the real picker buttons.
 *
 * It is not a control: it has no click handler and no tab stop. Keyboard,
 * screen-reader and phone users use the buttons inside it, which do exactly
 * what a drop does. Dropped files go to `onFiles`, the same handler the
 * buttons feed, so every rule (allow-list, size, pairing) applies equally.
 *
 * Measured contrast. At rest: a dashed `border-control` edge, 4.2:1 on
 * paper. Drag-over: a solid `primary-strong` edge on a `primary-wash`
 * ground, 6.0:1; ink text on that ground is 10.7:1.
 */
export function Dropzone({ prompt, onFiles, folders = false, disabled = false, className, children }: {
  /** The visible sentence, e.g. "Drag files here, or use the button below". */
  prompt: string;
  onFiles: (files: DroppedFile[]) => void;
  /** Walk dropped folders and keep relative paths (the archive upload). */
  folders?: boolean;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const t = useMessages();
  const [over, setOver] = useState(false);
  // dragenter/dragleave fire for every child crossed; count them so the
  // highlight does not flicker while moving over the buttons.
  const depth = useRef(0);

  function reset() {
    depth.current = 0;
    setOver(false);
  }

  return (
    <div
      data-dropzone=""
      data-drag-over={over ? 'true' : undefined}
      className={cn(
        'rounded-2xl border-2 border-dashed p-4 transition-colors sm:p-6',
        over ? 'border-solid border-primary-strong bg-primary-wash' : 'border-control bg-paper',
        disabled && 'opacity-60',
        className,
      )}
      onDragEnter={(e) => {
        if (!dragHasFiles(e.dataTransfer)) return;
        e.preventDefault();
        depth.current += 1;
        if (!disabled) setOver(true);
      }}
      onDragOver={(e) => {
        if (!dragHasFiles(e.dataTransfer)) return;
        // Without this the browser opens the file instead of dropping it here.
        e.preventDefault();
        e.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
      }}
      onDragLeave={(e) => {
        if (!dragHasFiles(e.dataTransfer)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(e) => {
        if (!dragHasFiles(e.dataTransfer)) return;
        e.preventDefault();
        reset();
        if (disabled) return;
        void readDroppedFiles(e.dataTransfer, { folders }).then((files) => { if (files.length) onFiles(files); });
      }}
    >
      <p className="flex items-center gap-3 text-ink">
        <CloudUpload size={28} className={over ? 'text-primary-strong' : 'text-muted'} aria-hidden />
        <span className="font-medium">{over ? t('dropzone.release') : prompt}</span>
      </p>
      <div className="mt-4 flex flex-wrap gap-3">{children}</div>
    </div>
  );
}
