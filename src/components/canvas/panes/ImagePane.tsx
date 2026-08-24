import { useEffect, useState } from 'react';
import { Maximize2, X } from 'lucide-react';
import type { SourceValue } from '../types';
import { api } from '../../../utils/api';
import PaneFrame from './PaneFrame';

interface ImagePaneProps {
  title: string;
  code?: string;
  source?: SourceValue;
}

/**
 * Resolves the best browser-loadable src for an image source.
 * Prefers a served `path` (with `?rev=` cache-bust) > data_url > url.
 */
function resolveSrc(source?: SourceValue): string | null {
  if (!source) return null;
  // Defensive: never let a missing helper throw and blank the canvas.
  if (source.path) return api?.bldr?.assetUrl?.(source.path, source.rev) ?? null;
  if (source.data_url) return source.data_url;
  if (source.url) return source.url;
  return null;
}

/** Image pane — top view / section / elevations / front view. Double-click (or the
 * expand button) opens a full-screen preview. The image sits on a uniform white
 * mat with even padding so every pane reads consistently regardless of aspect. */
export default function ImagePane({ title, code, source }: ImagePaneProps) {
  const src = resolveSrc(source);
  const alt = source?.alt || title;
  const [preview, setPreview] = useState(false);
  // Broken/unloadable image → graceful placeholder, never the browser's broken
  // icon. Keyed by src so a repaint with a fresh rev gets a clean retry.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const broken = src !== null && failedSrc === src;

  // Close the preview on Escape.
  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPreview(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview]);

  return (
    <PaneFrame title={title} code={code} flush empty={!src}>
      {src && broken && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-white p-3 text-neutral-400">
          <span className="text-3xl">✏️</span>
          <span className="text-xs">This sheet couldn't be displayed — ask the assistant to redraw it.</span>
        </div>
      )}
      {src && !broken && (
        <div
          className="group absolute inset-0 flex items-center justify-center bg-white p-1.5"
          onDoubleClick={() => setPreview(true)}
          title="Double-click to preview"
        >
          <img
            src={src}
            alt={alt}
            draggable={false}
            onError={() => setFailedSrc(src)}
            className="max-h-full max-w-full select-none object-contain cursor-zoom-in"
          />
          {/* expand affordance (discoverability for the double-click preview) */}
          <button
            type="button"
            onClick={() => setPreview(true)}
            aria-label="Preview"
            className="absolute right-2 top-2 rounded-md bg-black/55 p-1.5 text-white opacity-0 transition-opacity hover:bg-black/75 group-hover:opacity-100"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* full-screen preview */}
      {preview && src && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6"
          onClick={() => setPreview(false)}
          role="dialog"
          aria-modal="true"
          aria-label={`${alt} preview`}
        >
          <img
            src={src}
            alt={alt}
            className="max-h-full max-w-full object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            onClick={() => setPreview(false)}
            aria-label="Close preview"
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
          >
            <X className="h-5 w-5" />
          </button>
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-xs text-white/90">
            {alt}
          </div>
        </div>
      )}
    </PaneFrame>
  );
}
