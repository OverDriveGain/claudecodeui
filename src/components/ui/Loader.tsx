import Lottie from 'lottie-react';
import type { CSSProperties } from 'react';

import orbit from '@/assets/loaders/orbit.json';
import petals from '@/assets/loaders/petals.json';
import atom from '@/assets/loaders/atom.json';
import cubes from '@/assets/loaders/cubes.json';

/**
 * The "M" loading framework.
 *
 * A single <Loader> backed by a registry of brand-purple animations. `orbit`
 * is the custom-built default; `petals`/`atom`/`cubes` are recolored Lotties;
 * `logo` reuses the animated logo spinner served from /public.
 */
export const LOADER_VARIANTS = {
  orbit, // custom: purple dots pulsing around a ring (default)
  petals, // collapsing purple petal ring
  atom, // orbiting atom rings
  cubes, // isometric assembling cubes
} as const;

export type LoaderVariant = keyof typeof LOADER_VARIANTS | 'logo';

const SIZE_PX = { sm: 32, md: 56, lg: 96, xl: 160 } as const;
export type LoaderSize = keyof typeof SIZE_PX;

type LoaderProps = {
  /** Which animation to show. Defaults to the custom `orbit`. */
  variant?: LoaderVariant;
  /** Preset size token, or pass a raw pixel number. */
  size?: LoaderSize | number;
  /** Optional caption rendered under the animation. */
  label?: string;
  /** Render as a centered full-screen overlay (app boot / route guard). */
  fullscreen?: boolean;
  className?: string;
  /** Accessible status text (defaults to label or "Loading"). */
  ariaLabel?: string;
};

export default function Loader({
  variant = 'orbit',
  size = 'md',
  label,
  fullscreen = false,
  className = '',
  ariaLabel,
}: LoaderProps) {
  const px = typeof size === 'number' ? size : SIZE_PX[size];
  const box: CSSProperties = { width: px, height: px };
  const status = ariaLabel ?? label ?? 'Loading';

  const art =
    variant === 'logo' ? (
      <img src="/logo-spinner.apng" alt="" aria-hidden="true" style={box} />
    ) : (
      <Lottie
        animationData={LOADER_VARIANTS[variant]}
        loop
        autoplay
        style={box}
        aria-hidden="true"
        rendererSettings={{ preserveAspectRatio: 'xMidYMid meet' }}
      />
    );

  const inner = (
    <div className={`flex flex-col items-center justify-center gap-3 ${className}`}>
      <div role="status" aria-label={status}>
        {art}
        <span className="sr-only">{status}</span>
      </div>
      {label ? <p className="text-sm text-muted-foreground">{label}</p> : null}
    </div>
  );

  if (!fullscreen) return inner;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      {inner}
    </div>
  );
}
