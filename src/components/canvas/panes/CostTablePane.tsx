import type { SourceValue, CostData } from '../types';
import PaneFrame from './PaneFrame';

interface CostTablePaneProps {
  title: string;
  code?: string;
  source?: SourceValue;
}

function asCostData(source?: SourceValue): CostData | null {
  const data = source?.data as CostData | undefined;
  if (!data || !Array.isArray(data.rows)) return null;
  return data;
}

const fmt = (n: number, currency?: string) =>
  `${currency ? currency + ' ' : ''}${n.toLocaleString('en-US')}`;

/** Cost pane — styled as the drawing set's bill-of-quantities sheet: ink table
 * on white paper, hairline rules, tabular figures, red-accented total. */
export default function CostTablePane({ title, code, source }: CostTablePaneProps) {
  const data = asCostData(source);

  return (
    <PaneFrame title={title} code={code} empty={!data}>
      {data && (
        <div className="flex h-full w-full flex-col self-start overflow-auto px-2 pt-1">
          {data.name && (
            <div className="pb-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-neutral-700">
              {data.name}
            </div>
          )}
          <table className="w-full text-left text-xs text-neutral-800">
            <thead>
              <tr className="border-b border-neutral-800 text-[10px] uppercase tracking-[0.08em] text-neutral-500">
                <th className="py-1 pr-2 font-medium">Item</th>
                <th className="py-1 pr-2 text-right font-medium">Qty</th>
                <th className="py-1 pr-2 font-medium">Unit</th>
                <th className="py-1 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => (
                <tr key={i} className="border-b border-neutral-200">
                  <td className="py-1 pr-2">{row.item}</td>
                  <td className="py-1 pr-2 text-right tabular-nums text-neutral-500">{row.qty ?? ''}</td>
                  <td className="py-1 pr-2 text-neutral-500">{row.unit ?? ''}</td>
                  <td className="py-1 text-right font-medium tabular-nums">{fmt(row.cost, data.currency)}</td>
                </tr>
              ))}
            </tbody>
            {typeof data.total === 'number' && (
              <tfoot>
                <tr className="border-t-2 border-neutral-800 font-semibold">
                  <td className="py-1.5 uppercase tracking-[0.08em] text-neutral-800" colSpan={3}>
                    Total
                  </td>
                  <td className="py-1.5 text-right tabular-nums" style={{ color: '#D52027' }}>
                    {fmt(data.total, data.currency)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </PaneFrame>
  );
}
