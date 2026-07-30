import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../utils/api';

/**
 * /journey — the TABU product-foundation document as its own page: the second
 * part of the product (the land→key platform journey) beside the design
 * studio. Confidential: admin-gated like /admin; the document itself is served
 * by the authenticated /api/bldr/admin/journey endpoint.
 */
export default function JourneyPage() {
  const [admin, setAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.bldr.admin.me();
        const data = res.ok ? await res.json() : null;
        setAdmin(Boolean(data?.admin));
      } catch {
        setAdmin(false);
      }
    })();
  }, []);

  if (admin === null) {
    return <div className="flex h-full items-center justify-center text-muted-foreground">Loading…</div>;
  }
  if (!admin) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <div className="text-lg font-semibold">Admin only</div>
        <Link to="/" className="text-primary underline">Back to BLDR</Link>
      </div>
    );
  }

  const src = `/api/bldr/admin/journey?token=${encodeURIComponent(localStorage.getItem('auth-token') || '')}`;
  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
        <div>
          <span className="font-semibold">طابو TABU — رحلة المستخدم الكاملة</span>
          <span className="ml-2 text-xs text-muted-foreground">Product foundation · V1.1 · confidential</span>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/admin" className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent">
            ⚙ Admin
          </Link>
          <Link to="/" className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent">
            ← Studio
          </Link>
        </div>
      </div>
      <iframe src={src} title="TABU user journey" className="min-h-0 w-full flex-1 border-0 bg-white" />
    </div>
  );
}
