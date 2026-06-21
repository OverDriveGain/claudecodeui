import { useState, useCallback } from 'react';
import { Download, FileText, ExternalLink, Loader2 } from 'lucide-react';

import { api } from '../../../../../utils/api';

type FileDeliveryContentProps = {
  /** Absolute file paths the agent delivered (SendUserFile `files`). */
  files: string[];
  /** Optional human caption the agent attached. */
  caption?: string;
  /** DB/remote project id used to resolve + stream the bytes (agent's cwd is the root). */
  projectId?: string | null;
};

const basename = (p: string) => p.split('/').filter(Boolean).pop() || p;

/**
 * Renders a `SendUserFile` delivery as real, downloadable file cards instead of
 * raw tool JSON. The agent uploads the blob to claude.ai (we never see those
 * bytes), but the delivered path is on the agent's host and lives under its cwd,
 * so MyMu streams it through the existing authenticated files/content endpoint
 * (resolveProjectRootById -> agent cwd -> byte stream). Download must always be
 * available — never gated behind a preview that may not render.
 */
export function FileDeliveryContent({ files, caption, projectId }: FileDeliveryContentProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch the bytes once (authenticated) and hand back a blob + object URL.
  const fetchBlob = useCallback(
    async (path: string): Promise<{ blob: Blob; url: string } | null> => {
      if (!projectId) {
        setError('No project context — cannot fetch this file.');
        return null;
      }
      const res = await api.readDeliveredFile(projectId, path);
      if (!res.ok) {
        setError(res.status === 404 ? 'File no longer on disk.' : `Couldn’t fetch file (HTTP ${res.status}).`);
        return null;
      }
      const blob = await res.blob();
      return { blob, url: URL.createObjectURL(blob) };
    },
    [projectId],
  );

  const handleDownload = useCallback(
    async (path: string) => {
      setError(null);
      setBusy(path);
      try {
        const got = await fetchBlob(path);
        if (!got) return;
        const a = document.createElement('a');
        a.href = got.url;
        a.download = basename(path);
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(got.url);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [fetchBlob],
  );

  const handleOpen = useCallback(
    async (path: string) => {
      setError(null);
      setBusy(path);
      try {
        const got = await fetchBlob(path);
        if (!got) return;
        // Open in a new tab for in-browser preview (PDF/image/text). The object
        // URL is left for the new tab to consume; the browser reclaims it on close.
        window.open(got.url, '_blank', 'noopener,noreferrer');
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [fetchBlob],
  );

  if (!Array.isArray(files) || files.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {caption ? <div className="text-xs text-muted-foreground">{caption}</div> : null}
      {files.map((path) => (
        <div
          key={path}
          className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-2"
        >
          <FileText className="h-4 w-4 flex-shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate text-[13px] text-foreground" title={path}>
            {basename(path)}
          </span>
          <button
            type="button"
            title="Open in new tab"
            aria-label={`Open ${basename(path)}`}
            disabled={busy === path}
            onClick={() => handleOpen(path)}
            className="flex-shrink-0 rounded p-1 text-muted-foreground/80 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            {busy === path ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
          </button>
          <button
            type="button"
            title="Download"
            aria-label={`Download ${basename(path)}`}
            disabled={busy === path}
            onClick={() => handleDownload(path)}
            className="flex-shrink-0 rounded p-1 text-muted-foreground/80 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
          </button>
        </div>
      ))}
      {error ? <div className="text-xs text-destructive">{error}</div> : null}
    </div>
  );
}
