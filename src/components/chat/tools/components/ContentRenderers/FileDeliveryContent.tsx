import { useState, useCallback } from 'react';
import { Download, FileText, ExternalLink, Loader2 } from 'lucide-react';

import { api } from '../../../../../utils/api';
import { AUTH_TOKEN_STORAGE_KEY } from '../../../../auth/constants';

type FileDeliveryContentProps = {
  /** Absolute file paths the agent delivered (SendUserFile `files`). */
  files: string[];
  /** Optional human caption the agent attached. */
  caption?: string;
  /** DB/remote project id used to resolve + stream the bytes (agent's cwd is the root). */
  projectId?: string | null;
};

const basename = (p: string) => p.split('/').filter(Boolean).pop() || p;
const extOf = (p: string) => (basename(p).split('.').pop() || '').toLowerCase();

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus', 'oga']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv']);

type MediaKind = 'image' | 'audio' | 'video' | 'other';
const kindOf = (p: string): MediaKind => {
  const ext = extOf(p);
  if (IMAGE_EXT.has(ext)) return 'image';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (VIDEO_EXT.has(ext)) return 'video';
  return 'other';
};

/**
 * Build an authenticated streaming URL for the delivered-file endpoint. Media
 * elements (<img>/<audio>/<video>) can't set an Authorization header, so the
 * token rides as a query param — the auth middleware accepts ?token= — letting
 * the browser stream the bytes natively (with Range for audio/video seeking),
 * with no manual blob download. Same approach the file-tree VideoViewer uses.
 */
function streamUrl(projectId: string, path: string): string {
  const token = localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) || '';
  const params = new URLSearchParams({ path });
  if (token) params.set('token', token);
  return `/api/projects/${encodeURIComponent(projectId)}/delivered-file?${params.toString()}`;
}

/**
 * Renders a `SendUserFile` delivery inline: images show directly, audio/video get
 * players, everything is viewable without a manual download. The agent uploads
 * the blob to claude.ai (we never see those bytes), but the delivered path is on
 * the agent's host under its cwd, so MyMu streams it through the authenticated
 * delivered-file endpoint (host-local, or proxied to the owning peer for a
 * cross-host agent). A download button is always available as a fallback.
 */
export function FileDeliveryContent({ files, caption, projectId }: FileDeliveryContentProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failedPreview, setFailedPreview] = useState<Set<string>>(new Set());

  const markPreviewFailed = useCallback((path: string) => {
    setFailedPreview((prev) => {
      const next = new Set(prev);
      next.add(path);
      return next;
    });
  }, []);

  // Fetch the bytes once (authenticated) for a forced download that keeps the
  // original filename — inline previews stream via the URL directly.
  const handleDownload = useCallback(
    async (path: string) => {
      if (!projectId) {
        setError('No project context — cannot fetch this file.');
        return;
      }
      setError(null);
      setBusy(path);
      try {
        const res = await api.readDeliveredFile(projectId, path);
        if (!res.ok) {
          setError(res.status === 404 ? 'File no longer on disk.' : `Couldn’t fetch file (HTTP ${res.status}).`);
          return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = basename(path);
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [projectId],
  );

  if (!Array.isArray(files) || files.length === 0) return null;

  return (
    <div className="space-y-2">
      {caption ? <div className="text-xs text-muted-foreground">{caption}</div> : null}
      {files.map((path) => {
        const name = basename(path);
        const kind = projectId ? kindOf(path) : 'other';
        const canPreview = kind !== 'other' && !failedPreview.has(path);
        const url = projectId ? streamUrl(projectId, path) : '';

        return (
          <div key={path} className="overflow-hidden rounded-md border border-border bg-card">
            {/* Inline preview */}
            {canPreview && kind === 'image' && (
              <a href={url} target="_blank" rel="noopener noreferrer" className="block bg-black/5 dark:bg-white/5">
                <img
                  src={url}
                  alt={name}
                  loading="lazy"
                  onError={() => markPreviewFailed(path)}
                  className="mx-auto max-h-80 w-auto max-w-full object-contain"
                />
              </a>
            )}
            {canPreview && kind === 'video' && (
              <video
                src={url}
                controls
                preload="metadata"
                onError={() => markPreviewFailed(path)}
                className="max-h-80 w-full bg-black"
              >
                Your browser does not support the video tag.
              </video>
            )}
            {canPreview && kind === 'audio' && (
              <div className="px-2.5 pt-2">
                <audio src={url} controls preload="metadata" onError={() => markPreviewFailed(path)} className="w-full">
                  Your browser does not support the audio element.
                </audio>
              </div>
            )}

            {/* Name + actions row */}
            <div className="flex items-center gap-2 px-2.5 py-2">
              <FileText className="h-4 w-4 flex-shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground" title={path}>
                {name}
              </span>
              {url ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open in new tab"
                  aria-label={`Open ${name}`}
                  className="flex-shrink-0 rounded p-1 text-muted-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
              ) : null}
              <button
                type="button"
                title="Download"
                aria-label={`Download ${name}`}
                disabled={busy === path}
                onClick={() => handleDownload(path)}
                className="flex-shrink-0 rounded p-1 text-muted-foreground/80 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                {busy === path ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              </button>
            </div>
          </div>
        );
      })}
      {error ? <div className="text-xs text-destructive">{error}</div> : null}
    </div>
  );
}
