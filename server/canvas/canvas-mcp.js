/**
 * Project Canvas — in-process MCP tool (bldr_canvas / update_canvas)
 *
 * Exposes a single SDK MCP tool, `update_canvas`, that lets the agent push
 * structured content into the bldr "Canvas" view — a fixed set of heterogeneous
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
 * Tool name as seen by the client: `mcp__bldr_canvas__update_canvas`.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import path from 'path';
import { WORKSPACE_BASE } from '../bldr/workspace.js';
import { startGeneration, getJob, canGenerate } from '../bldr/generate.js';
import { beginNewProject } from '../bldr/gallery.js';

/**
 * AssetRef — a reference to a binary asset (image, model, pdf). Exactly one of
 * the three forms is expected; we don't hard-fail if more are present, the
 * frontend prefers data_url > url > path.
 *   - data_url: a self-contained `data:<mime>;base64,...` URL (best for small images)
 *   - path: an absolute path on the bldr host (served later via an asset endpoint)
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

const costData = z
  .object({
    data: z
      .object({
        name: z.string().optional().describe('Dataset name, e.g. "3D building cost".'),
        currency: z.string().optional(),
        rows: z
          .array(
            z.object({
              item: z.string(),
              qty: z.number().optional(),
              unit: z.string().optional(),
              cost: z.number(),
            }),
          )
          .optional(),
        total: z.number().optional(),
      })
      .describe('The cost dataset (rows + total).'),
  })
  .describe('Costs pane: a named cost dataset.');

const locationData = z
  .object({
    data: z
      .object({
        lat: z.number(),
        lng: z.number(),
        zoom: z.number().optional(),
        label: z.string().optional(),
        model: z.unknown().optional(),
      })
      .describe('Placement in the All-Dubai 3D map.'),
  })
  .describe('Location pane: where the building sits on the map.');

// bldr data sources. Image panes take an AssetRef (prefer `path` to a file you
// wrote in this project folder). Locks: top_view/elevations/front_view/costs/
// location change together; section is independent.
const inputSchema = {
  top_view: assetRef.optional().describe('Top-down / plan view image (AssetRef — prefer path).'),
  section: assetRef.optional().describe('Vertical section image (AssetRef). INDEPENDENT of the lock group.'),
  elevations: assetRef.optional().describe('Elevation drawings image (AssetRef).'),
  front_view: assetRef.optional().describe('Front elevation image (AssetRef).'),
  costs: costData.optional(),
  location: locationData.optional(),
  note: z
    .string()
    .optional()
    .describe('Optional human-readable note describing what changed in this update.'),
};

/**
 * Returns the list of pane keys that this payload actually touches, so the ack
 * can tell the model exactly what landed (and so we never silently no-op).
 */
// Image panes are real BTI drawings during the mockup phase — agent updates to them
// are ignored (only costs/location are computed live).
const READONLY_IMAGE_PANES = ['top_view', 'section', 'elevations', 'front_view'];

function updatedPanes(args) {
  const ids = ['costs', 'location'];
  return ids.filter((id) => args[id]);
}

function blockedImagePanes(args) {
  return READONLY_IMAGE_PANES.filter((id) => args[id]);
}

// True when this chat session runs inside a customer project workspace (the
// only place design generation applies — never fleet/agent working dirs).
export function isCustomerWorkspace(cwd) {
  if (!cwd) return false;
  const resolved = path.resolve(cwd);
  const base = path.resolve(WORKSPACE_BASE);
  return resolved !== base && resolved.startsWith(base + path.sep);
}

/**
 * Builds the in-process Canvas MCP server. Returns the server config object that
 * gets merged into `sdkOptions.mcpServers` in claude-sdk.js.
 *
 * `workspaceCwd` is the chat session's working directory — for customer chats
 * that IS their project workspace, which lets generate_design run the real
 * per-pane generation engine in-process (shared job state with /api/bldr).
 */
export function createCanvasMcpServer(workspaceCwd) {
  const updateCanvas = tool(
    'update_canvas',
    'Update the computed bldr Canvas panes. The image panes (top_view, section, '
      + 'elevations, front_view) are produced ONLY by generate_design and are '
      + 'READ-ONLY here — do NOT pass them, do NOT write image files. Use this '
      + 'only for a quick costs tweak or a location pin correction (lat/lng/label) '
      + 'without a redesign; for any design change call generate_design instead. '
      + 'Each call updates ONLY the panes you provide; only those reload.',
    inputSchema,
    async (args) => {
      const panes = updatedPanes(args);
      const blocked = blockedImagePanes(args);

      if (panes.length === 0 && blocked.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'update_canvas: no updatable pane provided — nothing updated. '
                + 'Only costs and location can be updated (image panes are read-only real drawings).',
            },
          ],
          isError: true,
        };
      }

      // The actual rendering is driven client-side from the tool_use frame; the
      // handler just acknowledges. Image panes are real BTI drawings in the mockup
      // phase — silently ignored so the agent can't replace them with mock images.
      const notes = [];
      if (panes.length) notes.push(`Canvas updated: ${panes.join(', ')}.`);
      if (blocked.length) {
        notes.push(
          `Ignored ${blocked.join(', ')} — image panes are real BTI proposal drawings `
            + '(read-only in the mockup phase) and were NOT changed.',
        );
      }
      return { content: [{ type: 'text', text: notes.join(' ') }] };
    },
  );

  // The ONE way the chat produces the customer's design: kicks off the async
  // per-pane generation (plan/section/elevations/render/costs) for this
  // workspace. The panes fill in live beside the chat as each one lands.
  const generateDesign = tool(
    'generate_design',
    'Generate (or regenerate) the customer\'s FULL building design from a one-line '
      + 'brief: floor plan, section, elevations, photoreal front render and the cost '
      + 'table. Runs asynchronously — panes beside the chat fill in over ~1-3 minutes. '
      + 'Call this whenever the customer describes what they want to build OR asks to '
      + 'change the design; fold their changes into one complete updated brief '
      + '(e.g. "modern 2-floor 4-bedroom 3D-printed villa, 300 m², Dubai Hills, flat roof"). '
      + 'Their previous design is kept automatically in their project gallery.',
    {
      brief: z
        .string()
        .min(8)
        .max(300)
        .describe('One complete line describing the building: type, floors/rooms, size, area/location, style.'),
    },
    async ({ brief }) => {
      if (!isCustomerWorkspace(workspaceCwd)) {
        return {
          content: [{ type: 'text', text: 'generate_design is only available inside a customer project workspace.' }],
          isError: true,
        };
      }
      if (!canGenerate()) {
        return {
          content: [{ type: 'text', text: 'The design generation backend is not reachable right now — apologize and ask the customer to try again shortly.' }],
          isError: true,
        };
      }
      const wp = path.resolve(workspaceCwd);
      if (getJob(wp)?.running) {
        return {
          content: [{ type: 'text', text: 'A design generation is already running for this project — tell the customer it is underway and the panes will update shortly. Do not start another one.' }],
        };
      }
      beginNewProject(wp, brief); // archives the current design into their gallery
      startGeneration(wp, brief);
      return {
        content: [{
          type: 'text',
          text: `Design generation started for: "${brief}". The panes will fill in over the next 1-3 minutes — tell the customer their design is being generated and will appear beside the chat. Their previous design (if any) is saved under "My projects".`,
        }],
      };
    },
  );

  return createSdkMcpServer({
    name: 'bldr_canvas',
    version: '0.1.0',
    tools: [updateCanvas, generateDesign],
  });
}
