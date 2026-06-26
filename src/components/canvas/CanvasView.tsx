import { useTranslation } from 'react-i18next';

import type { Project } from '../../types/app';
import { useCanvasState } from '../../stores/useCanvasStore';

import type { CanvasPaneId } from './types';
import FreePane from './panes/FreePane';
import ImagePane from './panes/ImagePane';

interface CanvasViewProps {
  selectedProject?: Project | null;
}

const PANE_TITLES: Record<CanvasPaneId, string> = {
  top_view: 'Top view',
  three_d: 'Section',
  costs: 'Costs',
  free: 'Elevations',
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
      {/* BTI: 'Canvas' heading removed — clean single window */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-auto md:grid-cols-2 lg:grid-cols-3">
        <div className="min-h-[180px]">
          <ImagePane title={PANE_TITLES.top_view} asset={canvas.values.top_view} />
        </div>
        <div className="min-h-[180px]">
          <PanePlaceholder title={PANE_TITLES.three_d} />
        </div>
        <div className="min-h-[180px]">
          <PanePlaceholder title={PANE_TITLES.costs} />
        </div>
        <div className="min-h-[180px]">
          <FreePane title={PANE_TITLES.free} content={canvas.values.free} />
        </div>
        <div className="min-h-[180px]">
          <PanePlaceholder title={PANE_TITLES.map} />
        </div>
      </div>
    </div>
  );
}
