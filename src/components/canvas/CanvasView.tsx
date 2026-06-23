import { useTranslation } from 'react-i18next';

import type { Project } from '../../types/app';
import { useCanvasState } from '../../stores/useCanvasStore';

import type { CanvasPaneId } from './types';

interface CanvasViewProps {
  selectedProject?: Project | null;
}

const PANE_TITLES: Record<CanvasPaneId, string> = {
  top_view: 'Top view',
  three_d: '3D',
  costs: 'Costs',
  free: 'Notes',
  map: 'Map',
};

function PanePlaceholder({ title }: { title: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center rounded-lg border border-dashed border-border bg-muted/20 p-4">
      <div className="text-center">
        <div className="text-sm font-medium text-muted-foreground">{title}</div>
        <div className="mt-1 text-xs text-muted-foreground/70">No content yet</div>
      </div>
    </div>
  );
}

/**
 * Project Canvas — a fixed 5-pane grid (top_view, three_d, costs, free, map)
 * that mutates in place as the agent calls the update_canvas MCP tool. Lives in
 * the Canvas tab beside the chat thread.
 *
 * V1: cheap panes (free markdown, top_view image) are wired from the store;
 * three_d / costs / map are placeholders until their renderers land.
 */
export default function CanvasView({ selectedProject }: CanvasViewProps) {
  const { t } = useTranslation();
  const canvas = useCanvasState(selectedProject?.projectId);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">{t('tabs.canvas', 'Canvas')}</h2>
        {canvas.note ? (
          <span className="truncate text-xs text-muted-foreground" title={canvas.note}>
            {canvas.note}
          </span>
        ) : null}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-auto md:grid-cols-2 lg:grid-cols-3">
        <div className="min-h-[180px]">
          <PanePlaceholder title={PANE_TITLES.top_view} />
        </div>
        <div className="min-h-[180px]">
          <PanePlaceholder title={PANE_TITLES.three_d} />
        </div>
        <div className="min-h-[180px]">
          <PanePlaceholder title={PANE_TITLES.costs} />
        </div>
        <div className="min-h-[180px]">
          <PanePlaceholder title={PANE_TITLES.free} />
        </div>
        <div className="min-h-[180px]">
          <PanePlaceholder title={PANE_TITLES.map} />
        </div>
      </div>
    </div>
  );
}
