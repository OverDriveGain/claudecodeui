import type { SourceValue, CostData } from '../types';
import PaneFrame from './PaneFrame';

interface CostTablePaneProps {
  title: string;
  source?: SourceValue;
}

function asCostData(source?: SourceValue): CostData | null {
  const data = source?.data as CostData | undefined;
  if (!data || !Array.isArray(data.rows)) return null;
  return data;
}

const fmt = (n: number, currency?: string) =>
  `${currency ? currency + ' ' : ''}${n.toLocaleString('en-US')}`;

/** Cost pane — a named cost dataset (e.g. "3D building cost") as a table. */
export default function CostTablePane({ title, source }: CostTablePaneProps) {
  const data = asCostData(source);

  return (
    <PaneFrame title={title} empty={!data}>
      {data && (
        <div className="flex h-full w-full flex-col overflow-auto">
          {data.name && (
            <div className="px-1 pb-2 text-sm font-semibold text-foreground">{data.name}</div>
          )}
          <table className="w-full text-left text-xs">
            <thead className="text-muted-foreground">
              <tr className="border-b border-border/60">
                <th className="py-1 pr-2 font-medium">Item</th>
                <th className="py-1 pr-2 text-right font-medium">Qty</th>
                <th className="py-1 pr-2 font-medium">Unit</th>
                <th className="py-1 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => (
                <tr key={i} className="border-b border-border/30">
                  <td className="py-1 pr-2 text-foreground">{row.item}</td>
                  <td className="py-1 pr-2 text-right text-muted-foreground">{row.qty ?? ''}</td>
                  <td className="py-1 pr-2 text-muted-foreground">{row.unit ?? ''}</td>
                  <td className="py-1 text-right text-foreground">{fmt(row.cost, data.currency)}</td>
                </tr>
              ))}
            </tbody>
            {typeof data.total === 'number' && (
              <tfoot>
                <tr className="border-t border-border font-semibold">
                  <td className="py-1.5 text-foreground" colSpan={3}>Total</td>
                  <td className="py-1.5 text-right text-primary">{fmt(data.total, data.currency)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </PaneFrame>
  );
}
