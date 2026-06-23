import type { AssetRef } from '../types';

interface ImagePaneProps {
  title: string;
  asset?: AssetRef;
}

/**
 * Resolves the best browser-loadable src for an AssetRef.
 * V1 supports data_url and (http) url; `path` needs the asset endpoint (later),
 * so a path-only asset renders an unavailable state for now.
 */
function resolveSrc(asset?: AssetRef): string | null {
  if (!asset) return null;
  if (asset.data_url) return asset.data_url;
  if (asset.url) return asset.url;
  return null;
}

/**
 * Image pane — renders a top-view (or any image) AssetRef. V1: data_url / url.
 */
export default function ImagePane({ title, asset }: ImagePaneProps) {
  const src = resolveSrc(asset);

  if (!src) {
    const pathOnly = Boolean(asset?.path);
    return (
      <div className="flex h-full w-full items-center justify-center rounded-lg border border-dashed border-border bg-muted/20 p-4">
        <div className="text-center">
          <div className="text-sm font-medium text-muted-foreground">{title}</div>
          <div className="mt-1 text-xs text-muted-foreground/70">
            {pathOnly ? 'Host path — asset endpoint not wired yet' : 'No content yet'}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-lg border border-border bg-card">
      <div className="border-b border-border px-3 py-1.5 text-xs font-medium text-muted-foreground">
        {title}
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-2">
        <img
          src={src}
          alt={asset?.alt || title}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    </div>
  );
}
