/**
 * Project Canvas — in-process MCP tool (mymu_canvas / update_canvas)
 *
 * Exposes a single SDK MCP tool, `update_canvas`, that lets the agent push
 * structured content into the MyMu "Canvas" view — a fixed set of heterogeneous
 * panes (top_view image, three_d viewer, costs PDF/proposal, free markdown, map)
 * that mutate IN PLACE on each call, beside the chat thread.
 *
 * Design notes:
 * - This runs IN-PROCESS via @anthropic-ai/claude-agent-sdk `createSdkMcpServer`
 *   so it ships no child process and adds no non-SDK runtime deps.
 * - The tool does NOT render anything itself. The tool_use frame flows through
 *   the normal SDK → WebSocket → frontend path; the frontend taps it (ToolRenderer)
 *   to drive a CanvasStore and renders NOTHING in the chat thread. The handler's
 *   only job is to VALIDATE/NORMALIZE the payload and return a tiny ack so the
 *   model gets a clean tool_result and keeps going.
 * - Every field is optional and uses a latest-value-per-pane model: a call updates
 *   only the panes it names; unnamed panes are left untouched by the reducer.
 *
 * Tool name as seen by the client: `mcp__mymu_canvas__update_canvas`.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/**
 * AssetRef — a reference to a binary asset (image, model, pdf). Exactly one of
 * the three forms is expected; we don't hard-fail if more are present, the
 * frontend prefers data_url > url > path.
 *   - data_url: a self-contained `data:<mime>;base64,...` URL (best for small images)
 *   - path: an absolute path on the MyMu host (served later via an asset endpoint)
 *   - url: an http(s) URL the browser can fetch directly
 */
const assetRef = z
  .object({
    data_url: z.string().optional(),
    path: z.string().optional(),
    url: z.string().optional(),
    mime: z.string().optional(),
    alt: z.string().optional(),
  })
  .describe('Reference to an asset: data_url | path | url (one of).');

const inputSchema = {
  top_view: assetRef
    .optional()
    .describe('Top-down / plan view image of the project (AssetRef).'),
  three_d: assetRef
    .optional()
    .describe('A 3D model to render live (glTF/GLB AssetRef) for the three.js viewer.'),
  costs: z
    .object({
      pdf: assetRef.optional().describe('A cost proposal as a PDF (AssetRef).'),
      markdown: z.string().optional().describe('A cost breakdown as markdown (e.g. a table).'),
    })
    .optional()
    .describe('Cost / proposal pane: a PDF and/or a markdown breakdown.'),
  free: z
    .string()
    .optional()
    .describe('Free-form markdown for the notes/free pane.'),
  map: z
    .object({
      lat: z.number().optional(),
      lng: z.number().optional(),
      zoom: z.number().optional(),
      label: z.string().optional(),
      geojson: z.unknown().optional().describe('Optional GeoJSON overlay.'),
    })
    .optional()
    .describe('Map pane: a centre point (lat/lng/zoom) and optional GeoJSON.'),
  note: z
    .string()
    .optional()
    .describe('Optional human-readable note describing what changed in this update.'),
};

/**
 * Returns the list of pane keys that this payload actually touches, so the ack
 * can tell the model exactly what landed (and so we never silently no-op).
 */
function updatedPanes(args) {
  const panes = [];
  if (args.top_view) panes.push('top_view');
  if (args.three_d) panes.push('three_d');
  if (args.costs) panes.push('costs');
  if (typeof args.free === 'string') panes.push('free');
  if (args.map) panes.push('map');
  return panes;
}

/**
 * Builds the in-process Canvas MCP server. Returns the server config object that
 * gets merged into `sdkOptions.mcpServers` in claude-sdk.js.
 */
export function createCanvasMcpServer() {
  const updateCanvas = tool(
    'update_canvas',
    'Push structured content into the MyMu project Canvas (a fixed set of panes: '
      + 'top_view image, three_d model, costs PDF/markdown, free markdown, map). '
      + 'Each call updates ONLY the panes you provide; other panes are left as-is. '
      + 'Use this to show and progressively refine a project visual alongside the chat. '
      + 'Nothing is rendered into the chat thread — it updates the Canvas tab.',
    inputSchema,
    async (args) => {
      const panes = updatedPanes(args);

      if (panes.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'update_canvas: no pane fields provided — nothing updated. '
                + 'Provide at least one of: top_view, three_d, costs, free, map.',
            },
          ],
          isError: true,
        };
      }

      // The actual rendering is driven client-side from the tool_use frame; the
      // handler just acknowledges. Keep the ack tiny so it doesn't clutter context.
      return {
        content: [
          {
            type: 'text',
            text: `Canvas updated: ${panes.join(', ')}.`,
          },
        ],
      };
    },
  );

  return createSdkMcpServer({
    name: 'mymu_canvas',
    version: '0.1.0',
    tools: [updateCanvas],
  });
}
