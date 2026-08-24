import { useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { CanvasState } from './types';
import { SOURCE_META } from './dataSources';
import ImagePane from './panes/ImagePane';
import CostTablePane from './panes/CostTablePane';
import LocationPane from './panes/LocationPane';
import PaneErrorBoundary from './panes/PaneErrorBoundary';

interface ResultsCarouselProps {
  sources: CanvasState['sources'];
  onClose: () => void;
}

/**
 * Fullscreen, swipeable results viewer — phones show one full-size sheet at a
 * time and swipe between them (native scroll-snap, so touch swipe just works),
 * with dots + prev/next and a slide counter. Opened from the "View results"
 * button on the canvas (mobile only).
 */
export default function ResultsCarousel({ sources, onClose }: ResultsCarouselProps) {
  const { t } = useTranslation('bldr');
  const trackRef = useRef<HTMLDivElement>(null);
  const [idx, setIdx] = useState(0);
  const total = SOURCE_META.length;

  const onScroll = () => {
    const el = trackRef.current;
    if (!el) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    if (i !== idx) setIdx(Math.max(0, Math.min(total - 1, i)));
  };

  const goTo = (i: number) => {
    const el = trackRef.current;
    if (!el) return;
    const clamped = Math.max(0, Math.min(total - 1, i));
    el.scrollTo({ left: clamped * el.clientWidth, behavior: 'smooth' });
  };

  const meta = SOURCE_META[idx];
  const title = t(`panes.${meta.id}`, { defaultValue: meta.title });

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      {/* header: counter + close */}
      <div className="flex shrink-0 items-center justify-between px-4 py-3 text-white">
        <span className="text-sm font-medium">
          {title} · {t('results.counter', { n: idx + 1, total })}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('results.close', { defaultValue: 'Close' })}
          className="rounded-full bg-white/10 p-2 transition-colors hover:bg-white/20"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* swipeable track */}
      <div
        ref={trackRef}
        onScroll={onScroll}
        className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden"
      >
        {SOURCE_META.map((m) => {
          const source = sources[m.id];
          const paneTitle = t(`panes.${m.id}`, { defaultValue: m.title });
          return (
            <div key={m.id} className="flex h-full w-full shrink-0 snap-center p-3">
              <PaneErrorBoundary title={paneTitle}>
                {m.type === 'image' && <ImagePane title={paneTitle} code={m.code} source={source} />}
                {m.type === 'cost-table' && <CostTablePane title={paneTitle} code={m.code} source={source} />}
                {m.type === 'map-cesium' && <LocationPane title={paneTitle} code={m.code} source={source} />}
              </PaneErrorBoundary>
            </div>
          );
        })}
      </div>

      {/* footer: prev/next + dots */}
      <div className="flex shrink-0 items-center justify-between px-4 py-3">
        <button
          type="button"
          onClick={() => goTo(idx - 1)}
          disabled={idx === 0}
          aria-label="Previous"
          className="rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20 disabled:opacity-30"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-1.5">
          {SOURCE_META.map((m, i) => (
            <button
              key={m.id}
              type="button"
              onClick={() => goTo(i)}
              aria-label={`Go to ${i + 1}`}
              className={`h-2 rounded-full transition-all ${i === idx ? 'w-5 bg-primary' : 'w-2 bg-white/35'}`}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={() => goTo(idx + 1)}
          disabled={idx === total - 1}
          aria-label="Next"
          className="rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20 disabled:opacity-30"
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
