import { useEffect, useRef } from 'react';

import type { CanvasUpdate } from '../../canvas/types';
import { canvasStore } from '../../../stores/useCanvasStore';

/**
 * The MCP tool name as surfaced to the client (server name `mymu_canvas`,
 * tool `update_canvas`). MCP tools are namespaced `mcp__<server>__<tool>`.
 */
export const CANVAS_TOOL_NAME = 'mcp__mymu_canvas__update_canvas';

interface CanvasUpdateTapProps {
  payload: unknown;
  conversationId?: string;
}

/**
 * Renders nothing. Side-effect only: feeds one `update_canvas` payload into the
 * canvas store for the given conversation. Guards against re-applying the same
 * payload on re-render (which would wrongly bump pane revs) by remembering the
 * last-applied serialization for this mounted instance.
 *
 * One <ToolRenderer mode="input"> renders per tool_use message, so this component
 * is effectively one-per-update; the ref guard covers the store from React
 * re-rendering the same message (e.g. parent state churn).
 */
export function CanvasUpdateTap({ payload, conversationId }: CanvasUpdateTapProps) {
  const lastAppliedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!conversationId) return;
    if (!payload || typeof payload !== 'object') return;

    let serialized: string;
    try {
      serialized = JSON.stringify(payload);
    } catch {
      return;
    }
    if (serialized === lastAppliedRef.current) return;
    lastAppliedRef.current = serialized;

    canvasStore.applyUpdate(conversationId, payload as CanvasUpdate);
  }, [payload, conversationId]);

  return null;
}
