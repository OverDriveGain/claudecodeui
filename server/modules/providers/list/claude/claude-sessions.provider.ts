import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import type { IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage, generateMessageId, readObjectRecord } from '@/shared/utils.js';
import { sessionsDb } from '@/modules/database/index.js';

const PROVIDER = 'claude';

type ClaudeToolResult = {
  content: unknown;
  isError: boolean;
  subagentTools?: unknown;
  toolUseResult?: unknown;
};

type ClaudeHistoryResult =
  | AnyRecord[]
  | {
    messages?: AnyRecord[];
    total?: number;
    hasMore?: boolean;
  };

type ClaudeHistoryMessagesResult =
  | AnyRecord[]
  | {
    messages: AnyRecord[];
    total: number;
    hasMore: boolean;
    offset?: number;
    limit?: number | null;
  };

async function parseAgentTools(filePath: string): Promise<AnyRecord[]> {
  const tools: AnyRecord[] = [];

  try {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }

      try {
        const entry = JSON.parse(line) as AnyRecord;

        if (entry.message?.role === 'assistant' && Array.isArray(entry.message?.content)) {
          for (const part of entry.message.content as AnyRecord[]) {
            if (part.type === 'tool_use') {
              tools.push({
                toolId: part.id,
                toolName: part.name,
                toolInput: part.input,
                timestamp: entry.timestamp,
              });
            }
          }
        }

        if (entry.message?.role === 'user' && Array.isArray(entry.message?.content)) {
          for (const part of entry.message.content as AnyRecord[]) {
            if (part.type !== 'tool_result') {
              continue;
            }

            const tool = tools.find((candidate) => candidate.toolId === part.tool_use_id);
            if (!tool) {
              continue;
            }

            tool.toolResult = {
              content: typeof part.content === 'string'
                ? part.content
                : Array.isArray(part.content)
                  ? part.content
                    .map((contentPart: AnyRecord) => contentPart?.text || '')
                    .join('\n')
                  : JSON.stringify(part.content),
              isError: Boolean(part.is_error),
            };
          }
        }
      } catch {
        // Skip malformed lines that can happen during concurrent writes.
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Error parsing agent file ${filePath}:`, message);
  }

  return tools;
}

/**
 * Reads the tail of a JSONL transcript without parsing the whole file.
 *
 * Walks the file backward in chunks, parsing lines newest-first, and stops once
 * it has collected at least `minEntries` rows belonging to `sessionId` (or it
 * reaches the start of the file). This keeps "open a conversation" cheap even
 * for multi-megabyte transcripts — the full read only happens for an explicit
 * "Load all" request.
 *
 * Returns the matching entries in forward (oldest-first) order plus
 * `reachedStart`, which is true when the walk consumed byte 0 (so the tail is
 * actually the entire transcript and counts derived from it are exact).
 */
async function readSessionTailEntries(
  jsonLPath: string,
  sessionId: string,
  minEntries: number,
): Promise<{ entries: AnyRecord[]; reachedStart: boolean }> {
  const CHUNK = 256 * 1024;
  const handle = await fsp.open(jsonLPath, 'r');
  try {
    const { size } = await handle.stat();
    let pos = size;
    // Head-less fragment of the earliest line in the previously-read (later)
    // chunk; it is the continuation of a line that spans the chunk boundary.
    let carry = '';
    const collected: AnyRecord[] = [];
    let reachedStart = false;

    while (pos > 0 && collected.length < minEntries) {
      const readStart = Math.max(0, pos - CHUNK);
      const length = pos - readStart;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, readStart);
      pos = readStart;

      const text = buffer.toString('utf8') + carry;
      const lines = text.split('\n');
      if (readStart === 0) {
        reachedStart = true;
        carry = '';
      } else {
        // The first line is still missing its head (lives in an earlier chunk).
        carry = lines.shift() ?? '';
      }

      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.trim()) {
          continue;
        }
        try {
          const entry = JSON.parse(line) as AnyRecord;
          if (entry.sessionId === sessionId) {
            collected.push(entry);
          }
        } catch {
          // Skip malformed JSONL lines that can happen during concurrent writes.
        }
      }
    }

    if (pos === 0) {
      reachedStart = true;
    }

    collected.reverse();
    return { entries: collected, reachedStart };
  } finally {
    await handle.close();
  }
}

/**
 * Attaches `subagentTools` to messages whose tool results reference a subagent
 * transcript, then returns them sorted oldest-first. Shared by the full-read and
 * tail-read paths so both surface identical subagent data.
 */
async function enrichWithSubagentTools(
  messages: AnyRecord[],
  projectDir: string,
  agentFiles: string[],
): Promise<AnyRecord[]> {
  const agentToolsCache = new Map<string, AnyRecord[]>();
  const agentIds = new Set<string>();
  for (const message of messages) {
    const agentId = message.toolUseResult?.agentId;
    if (agentId) {
      agentIds.add(String(agentId));
    }
  }

  for (const agentId of agentIds) {
    const agentFileName = `agent-${agentId}.jsonl`;
    if (!agentFiles.includes(agentFileName)) {
      continue;
    }
    const tools = await parseAgentTools(path.join(projectDir, agentFileName));
    agentToolsCache.set(agentId, tools);
  }

  for (const message of messages) {
    const agentId = message.toolUseResult?.agentId;
    if (!agentId) {
      continue;
    }
    const agentTools = agentToolsCache.get(String(agentId));
    if (agentTools && agentTools.length > 0) {
      message.subagentTools = agentTools;
    }
  }

  return messages.sort(
    (a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime(),
  );
}

/**
 * Reads only the tail of a session transcript (last `minEntries` rows or the
 * whole file, whichever is smaller) and enriches it with subagent tools.
 * `reachedStart` is true when the tail spans the entire transcript.
 */
async function getSessionTail(
  sessionId: string,
  minEntries: number,
): Promise<{ messages: AnyRecord[]; reachedStart: boolean }> {
  const jsonLPath = sessionsDb.getSessionById(sessionId)?.jsonl_path;
  if (!jsonLPath) {
    return { messages: [], reachedStart: true };
  }

  const projectDir = path.dirname(jsonLPath);
  const files = await fsp.readdir(projectDir);
  const agentFiles = files.filter((file) => file.endsWith('.jsonl') && file.startsWith('agent-'));

  const { entries, reachedStart } = await readSessionTailEntries(jsonLPath, sessionId, minEntries);
  const messages = await enrichWithSubagentTools(entries, projectDir, agentFiles);
  return { messages, reachedStart };
}

async function getSessionMessages(
  sessionId: string,
  limit: number | null,
  offset: number,
): Promise<ClaudeHistoryMessagesResult> {
  try {
    const jsonLPath = sessionsDb.getSessionById(sessionId)?.jsonl_path;

    if (!jsonLPath) {
      return { messages: [], total: 0, hasMore: false };
    }

    const projectDir = path.dirname(jsonLPath);
    const files = await fsp.readdir(projectDir);
    const agentFiles = files.filter((file) => file.endsWith('.jsonl') && file.startsWith('agent-'));

    const messages: AnyRecord[] = [];
    const agentToolsCache = new Map<string, AnyRecord[]>();

    const fileStream = fs.createReadStream(jsonLPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }

      try {
        const entry = JSON.parse(line) as AnyRecord;
        if (entry.sessionId === sessionId) {
          messages.push(entry);
        }
      } catch {
        // Skip malformed JSONL lines that can happen during concurrent writes.
      }
    }

    const agentIds = new Set<string>();
    for (const message of messages) {
      const agentId = message.toolUseResult?.agentId;
      if (agentId) {
        agentIds.add(String(agentId));
      }
    }

    for (const agentId of agentIds) {
      const agentFileName = `agent-${agentId}.jsonl`;
      if (!agentFiles.includes(agentFileName)) {
        continue;
      }

      const agentFilePath = path.join(projectDir, agentFileName);
      const tools = await parseAgentTools(agentFilePath);
      agentToolsCache.set(agentId, tools);
    }

    for (const message of messages) {
      const agentId = message.toolUseResult?.agentId;
      if (!agentId) {
        continue;
      }

      const agentTools = agentToolsCache.get(String(agentId));
      if (agentTools && agentTools.length > 0) {
        message.subagentTools = agentTools;
      }
    }

    const sortedMessages = messages.sort(
      (a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime(),
    );
    const total = sortedMessages.length;

    if (limit === null) {
      return sortedMessages;
    }

    const startIndex = Math.max(0, total - offset - limit);
    const endIndex = total - offset;
    const paginatedMessages = sortedMessages.slice(startIndex, endIndex);
    const hasMore = startIndex > 0;

    return {
      messages: paginatedMessages,
      total,
      hasMore,
      offset,
      limit,
    };
  } catch (error) {
    console.error(`Error reading messages for session ${sessionId}:`, error);
    return limit === null ? [] : { messages: [], total: 0, hasMore: false };
  }
}

/**
 * Claude writes a mix of truly internal transcript rows and "UI-hidden" local
 * command artifacts into the same JSONL stream.
 *
 * Important distinction:
 * - system reminders / caveats / interruption banners should stay hidden
 * - local command payloads (`<command-name>...`) and stdout wrappers
 *   (`<local-command-stdout>...`) should be remapped into normal chat messages
 *   instead of being discarded as internal content
 */
const INTERNAL_CONTENT_PREFIXES = [
  '<system-reminder>',
  '<local-command-caveat>',
  'Caveat:',
  '[Request interrupted',
] as const;

function isInternalContent(content: string): boolean {
  return INTERNAL_CONTENT_PREFIXES.some((prefix) => content.startsWith(prefix));
}

/**
 * User messages arrive prefixed with one or more
 * `<system-reminder>…</system-reminder>` wrappers (e.g. "Message sent at …")
 * followed by the real text. Dropping the whole message because it *starts* with
 * a reminder silently discarded real user messages — strip the wrappers and keep
 * what's left. Returns the cleaned, trimmed text (empty if it was only reminders).
 */
function stripSystemReminders(content: string): string {
  return content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

/**
 * The CLI writes "[Image: original WxH, displayed at WxH. …]" sizing notes next
 * to attached images. Locally those rows are isMeta (never rendered), but the
 * relay ships them as ordinary user rows, so remote transcripts showed them as
 * bubbles. Strip the note lines; the image itself renders via extractMessageImages.
 */
function stripImageSizeNotes(content: string): string {
  return content.replace(/^\[Image(?: #\d+)?: original \d+x\d+[^\]]*\]$/gm, '').trim();
}

/**
 * The relay represents an empty assistant turn (e.g. the no-op reply after
 * /clear) as a literal "(no content)" text block — never render it.
 */
function isEmptyAssistantPlaceholder(text: string): boolean {
  return text.trim() === '(no content)';
}

/**
 * Pull base64 image blocks out of a message-content array into render-ready
 * `{ name, data }` attachments (data is a `data:` URL). The normalizer otherwise
 * keeps only text, so a sent image (an `image` content block) would be dropped.
 */
function extractMessageImages(content: AnyRecord[]): { name: string; data: string }[] {
  const out: { name: string; data: string }[] = [];
  for (const part of content) {
    // Images and PDFs are the only attachment kinds carried as real bytes (base64
    // content blocks). The renderer detects the kind from the data: URL mime, so
    // a thumbnail vs a file chip falls out automatically. Other files (audio, zip,
    // ...) are not content blocks — the harness leaves them as text notes.
    if (part?.type === 'image' && part.source?.type === 'base64' && part.source?.data) {
      const media = typeof part.source.media_type === 'string' ? part.source.media_type : 'image/png';
      out.push({ name: 'image', data: `data:${media};base64,${part.source.data}` });
    } else if (part?.type === 'document' && part.source?.type === 'base64' && part.source?.data) {
      const media = typeof part.source.media_type === 'string' ? part.source.media_type : 'application/pdf';
      const name = typeof part.title === 'string' && part.title.trim() ? part.title : 'document.pdf';
      out.push({ name, data: `data:${media};base64,${part.source.data}` });
    }
  }
  return out;
}

/**
 * Claude wraps local slash-command metadata in lightweight XML-like tags inside
 * a plain string payload. We intentionally parse only the small tag surface we
 * care about instead of introducing a generic XML parser for untrusted history.
 */
function extractTaggedContent(content: string, tagName: string): string | null {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
}

type ClaudeLocalCommandPayload = {
  commandName: string;
  commandMessage: string;
  commandArgs: string;
};

/**
 * Converts Claude's hidden local command wrapper into structured metadata.
 *
 * The three tags often coexist in one string payload. Returning `null` lets the
 * normal text path continue untouched for unrelated messages.
 */
function parseLocalCommandPayload(content: string): ClaudeLocalCommandPayload | null {
  const commandName = extractTaggedContent(content, 'command-name');
  const commandMessage = extractTaggedContent(content, 'command-message');
  const commandArgs = extractTaggedContent(content, 'command-args');

  if (commandName === null && commandMessage === null && commandArgs === null) {
    return null;
  }

  return {
    commandName: commandName ?? '',
    commandMessage: commandMessage ?? '',
    commandArgs: commandArgs ?? '',
  };
}

/**
 * Produces the short user-visible command string that should appear in chat.
 *
 * We prefer the slash-prefixed command name because that most closely matches
 * what the user actually typed, and only fall back to the message body when the
 * command name is unavailable in older transcript variants.
 */
function buildLocalCommandDisplayText(payload: ClaudeLocalCommandPayload): string {
  const commandName = payload.commandName.trim();
  const commandMessage = payload.commandMessage.trim();
  const commandArgs = payload.commandArgs.trim();
  const baseCommand = commandName || commandMessage;

  if (!baseCommand) {
    return '';
  }

  return commandArgs ? `${baseCommand} ${commandArgs}` : baseCommand;
}

/**
 * Claude local-command stdout may contain ANSI styling codes because it was
 * captured from the terminal. The web chat should receive readable plain text.
 */
function stripAnsiFormatting(text: string): string {
  return text.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

type TaskNotificationPayload = {
  taskId: string;
  taskStatus: string;
  summary: string;
  outputFile?: string;
};

/**
 * Parse task notification XML that Claude emits for background tasks.
 * Returns null if the content does not match the task notification format.
 */
function parseTaskNotification(content: string): TaskNotificationPayload | null {
  const taskIdMatch = /<task-id>([^<]*)<\/task-id>/.exec(content);
  const statusMatch = /<status>([^<]*)<\/status>/.exec(content);
  const summaryMatch = /<summary>([^<]*)<\/summary>/.exec(content);
  const outputFileMatch = /<output-file>([^<]*)<\/output-file>/.exec(content);

  if (taskIdMatch && statusMatch && summaryMatch) {
    return {
      taskId: taskIdMatch[1] || '',
      taskStatus: statusMatch[1] || 'completed',
      summary: summaryMatch[1] || '',
      outputFile: outputFileMatch ? outputFileMatch[1] : undefined,
    };
  }

  return null;
}

/**
 * Context-window fullness from raw transcript entries: the LAST assistant entry
 * carrying `message.usage` describes the most recent API call — its input +
 * cache tokens (plus that turn's output) approximate what the next call will
 * occupy. Window size comes from CONTEXT_WINDOW (same env the web UI uses).
 */
export function deriveContextUsage(raws: unknown[]): { usedTokens: number; windowTokens: number } | null {
  for (let i = raws.length - 1; i >= 0; i--) {
    const r = raws[i] as AnyRecord | null;
    const u = (r?.message as AnyRecord | undefined)?.usage as AnyRecord | undefined;
    if (u && typeof u.input_tokens === 'number') {
      const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      const usedTokens =
        n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens) + n(u.output_tokens);
      const windowTokens = Number.parseInt(process.env.CONTEXT_WINDOW || '', 10) || 200_000;
      return { usedTokens, windowTokens };
    }
  }
  return null;
}

export class ClaudeSessionsProvider implements IProviderSessions {
  /**
   * Normalizes one Claude JSONL entry or live SDK stream event into the shared
   * message shape consumed by REST and WebSocket clients.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    if (raw.type === 'content_block_delta' && raw.delta?.text) {
      return [createNormalizedMessage({ kind: 'stream_delta', content: raw.delta.text, sessionId, provider: PROVIDER })];
    }
    if (raw.type === 'content_block_stop') {
      return [createNormalizedMessage({ kind: 'stream_end', sessionId, provider: PROVIDER })];
    }

    const messages: NormalizedMessage[] = [];
    // Prefer `created_at`: the relay stamps it on EVERY event (chronological,
    // fine-grained), whereas `timestamp` is only present on user events. Reading
    // `timestamp` first left assistant/system/tool events stamped at load time
    // (new Date()), which scrambled message order once the store sorts by time.
    const ts = raw.created_at || raw.timestamp || new Date().toISOString();
    const baseId = raw.uuid || generateMessageId('claude');

    /**
     * Claude writes a number of `system` rows to the transcript. Most are
     * internal bookkeeping the CLI never renders (turn_duration, stop_hook_summary,
     * away_summary, scheduled_task_fire, bridge_status, local_command, ...), but a
     * few ARE shown to the user in the terminal and must be mirrored here so the
     * web transcript matches what the operator saw:
     *   - api_error        → a real error line (overload/retry, request failures)
     *   - compact_boundary → the "Conversation compacted" divider
     *   - informational    → notices like "Unknown command: /admin"
     */
    if (raw.type === 'system' && raw.isMeta !== true) {
      const subtype = typeof raw.subtype === 'string' ? raw.subtype : '';
      if (subtype === 'api_error') {
        const errMsg =
          (raw.error && typeof raw.error === 'object' && typeof (raw.error as AnyRecord).message === 'string'
            ? (raw.error as AnyRecord).message
            : typeof raw.content === 'string'
              ? raw.content
              : '') as string;
        if (errMsg.trim()) {
          messages.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'error',
            content: errMsg,
          }));
        }
      } else if (subtype === 'compact_boundary' || subtype === 'informational') {
        const text = typeof raw.content === 'string' ? raw.content : '';
        if (text.trim()) {
          messages.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'system',
            content: text,
            level: typeof raw.level === 'string' ? raw.level : 'info',
            isSystemNotice: true,
          }));
        }
      }
      return messages;
    }

    /**
     * A tool_result's content can be an array of blocks — including IMAGE blocks
     * whose base64 payload runs to hundreds of KB. JSON.stringify'ing that into
     * the normalized `content` shipped megabyte "text" rows that clients then
     * try to LAY OUT as text (the iOS app froze for seconds per frame on such a
     * conversation). Extract the text, replace binary blocks with a marker.
     */
    const summarizeToolResultContent = (content: unknown): string => {
      if (typeof content === 'string') return content;
      if (!Array.isArray(content)) return JSON.stringify(content) ?? '';
      return content
        .map((p: AnyRecord) => {
          if (p?.type === 'text') return String(p.text ?? '');
          if (p?.type === 'image') {
            const mime = (p?.source as AnyRecord | undefined)?.media_type || 'image';
            return `[image: ${mime}]`;
          }
          return `[${String(p?.type ?? 'block')}]`;
        })
        .filter(Boolean)
        .join('\n');
    };

    if (raw.message?.role === 'user' && raw.message?.content && raw.isMeta !== true) {
      const userImages = Array.isArray(raw.message.content)
        ? extractMessageImages(raw.message.content)
        : [];
      if (Array.isArray(raw.message.content)) {
        for (let partIndex = 0; partIndex < raw.message.content.length; partIndex++) {
          const part = raw.message.content[partIndex];
          if (part.type === 'tool_result') {
            messages.push(createNormalizedMessage({
              id: `${baseId}_tr_${part.tool_use_id}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'tool_result',
              toolId: part.tool_use_id,
              content: summarizeToolResultContent(part.content),
              isError: Boolean(part.is_error),
              subagentTools: raw.subagentTools,
              toolUseResult: raw.toolUseResult,
            }));
          } else if (part.type === 'text') {
            const cleaned = stripImageSizeNotes(stripSystemReminders(part.text || ''));
            if (cleaned && !isInternalContent(cleaned)) {
              messages.push(createNormalizedMessage({
                id: `${baseId}_text_${partIndex}`,
                sessionId,
                timestamp: ts,
                provider: PROVIDER,
                kind: 'text',
                role: 'user',
                content: cleaned,
              }));
            }
          }
        }

        if (messages.length === 0) {
          const textParts = raw.message.content
            .filter((part: AnyRecord) => part.type === 'text')
            .map((part: AnyRecord) => part.text)
            .filter(Boolean)
            .join('\n');
          const cleanedParts = stripImageSizeNotes(stripSystemReminders(textParts));
          if (cleanedParts && !isInternalContent(cleanedParts)) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_text`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'user',
              content: cleanedParts,
            }));
          }
        }
      } else if (typeof raw.message.content === 'string') {
        const text = raw.message.content;

        /**
         * Claude stores compact summaries as synthetic "user" rows so the CLI
         * can resume the next session turn with the summary in-context.
         *
         * For the web UI this is much more useful as assistant-authored summary
         * text; otherwise it is both filtered by the generic internal-prefix
         * check and visually mislabeled as a user message.
         */
        if (raw.isCompactSummary === true && text.trim()) {
          messages.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'assistant',
            content: text,
            isCompactSummary: true,
          }));
          return messages;
        }

        /**
         * Local slash commands are serialized as tagged text even though they
         * are semantically a user action. Expose the parsed fields to the
         * frontend and emit a plain user-visible command string so the command
         * no longer disappears from history.
         */
        const localCommandPayload = parseLocalCommandPayload(text);
        if (localCommandPayload) {
          const displayText = buildLocalCommandDisplayText(localCommandPayload);
          // /clear leaves no visible trace in the CLI (the screen just resets),
          // and on relay sessions this row duplicates the typed "/clear" echo —
          // suppress it instead of rendering a stray user bubble.
          if (displayText && displayText !== '/clear') {
            messages.push(createNormalizedMessage({
              id: baseId,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'user',
              content: displayText,
              commandName: localCommandPayload.commandName,
              commandMessage: localCommandPayload.commandMessage,
              commandArgs: localCommandPayload.commandArgs,
              isLocalCommand: true,
            }));
          }
          return messages;
        }

        /**
         * Local command stdout is also written as a "user" row in Claude's
         * transcript, but it is terminal output produced in response to the
         * command. Re-label it as assistant text so the chat transcript matches
         * the actual conversational flow seen by the user.
         */
        const localCommandStdout = extractTaggedContent(text, 'local-command-stdout');
        if (localCommandStdout !== null) {
          const stdoutText = stripAnsiFormatting(localCommandStdout).trim();
          if (stdoutText) {
            messages.push(createNormalizedMessage({
              id: baseId,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'assistant',
              content: stdoutText,
              isLocalCommandStdout: true,
            }));
          }
          return messages;
        }

        /**
         * Task notifications are background task status updates emitted by Claude.
         * Parse them into a proper message type instead of rendering raw XML.
         */
        const taskNotif = parseTaskNotification(text);
        if (taskNotif) {
          messages.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'task_notification',
            content: taskNotif.summary,
            status: taskNotif.taskStatus,
            summary: taskNotif.summary,
          }));
          return messages;
        }

        const cleaned = stripImageSizeNotes(stripSystemReminders(text));
        if (cleaned && !isInternalContent(cleaned)) {
          messages.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'user',
            content: cleaned,
          }));
        }
      }

      // Attach any sent images to the user's text message (or emit a standalone
      // user row if the message was image-only) so the chat can show a thumbnail.
      if (userImages.length > 0) {
        const target = [...messages].reverse().find((m) => m.role === 'user' && m.kind === 'text');
        if (target) {
          target.images = userImages;
        } else {
          messages.push(createNormalizedMessage({
            id: `${baseId}_img`,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'user',
            content: '',
            images: userImages,
          }));
        }
      }
      return messages;
    }

    if (raw.type === 'thinking' && raw.message?.content) {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'thinking',
        content: raw.message.content,
      }));
      return messages;
    }

    if (raw.type === 'tool_use' && raw.toolName) {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName: raw.toolName,
        toolInput: raw.toolInput,
        toolId: raw.toolCallId || baseId,
      }));
      return messages;
    }

    if (raw.type === 'tool_result') {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_result',
        toolId: raw.toolCallId || '',
        content: raw.output || '',
        isError: false,
      }));
      return messages;
    }

    if (raw.message?.role === 'assistant' && raw.message?.content) {
      if (Array.isArray(raw.message.content)) {
        let partIndex = 0;
        for (const part of raw.message.content) {
          if (part.type === 'text' && part.text && !isEmptyAssistantPlaceholder(part.text)) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'assistant',
              content: part.text,
            }));
          } else if (part.type === 'tool_use') {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'tool_use',
              toolName: part.name,
              toolInput: part.input,
              toolId: part.id,
            }));
          } else if (part.type === 'thinking' && part.thinking) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'thinking',
              content: part.thinking,
            }));
          }
          partIndex++;
        }
      } else if (typeof raw.message.content === 'string' && !isEmptyAssistantPlaceholder(raw.message.content)) {
        messages.push(createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp: ts,
          provider: PROVIDER,
          kind: 'text',
          role: 'assistant',
          content: raw.message.content,
        }));
      }
      return messages;
    }

    return messages;
  }

  /**
   * Loads Claude JSONL history for a project/session and returns normalized
   * messages, preserving the existing pagination behavior from projects.js.
   */
  /**
   * Builds the normalized message list from raw JSONL rows: pairs tool results
   * back onto their tool_use messages and carries subagent tool data across.
   */
  private normalizeRawMessages(rawMessages: AnyRecord[], sessionId: string): NormalizedMessage[] {
    const toolResultMap = new Map<string, ClaudeToolResult>();
    for (const raw of rawMessages) {
      if (raw.message?.role === 'user' && Array.isArray(raw.message?.content)) {
        for (const part of raw.message.content) {
          if (part.type === 'tool_result' && part.tool_use_id) {
            toolResultMap.set(part.tool_use_id, {
              content: part.content,
              isError: Boolean(part.is_error),
              subagentTools: raw.subagentTools,
              toolUseResult: raw.toolUseResult,
            });
          }
        }
      }
    }

    const normalized: NormalizedMessage[] = [];
    for (const raw of rawMessages) {
      normalized.push(...this.normalizeMessage(raw, sessionId));
    }

    for (const msg of normalized) {
      if (msg.kind === 'tool_use' && msg.toolId && toolResultMap.has(msg.toolId)) {
        const toolResult = toolResultMap.get(msg.toolId);
        if (!toolResult) {
          continue;
        }

        msg.toolResult = {
          content: typeof toolResult.content === 'string'
            ? toolResult.content
            : JSON.stringify(toolResult.content),
          isError: toolResult.isError,
          toolUseResult: toolResult.toolUseResult,
        };
        msg.subagentTools = toolResult.subagentTools;
      }
    }

    return normalized;
  }

  private countConversationMessages(normalized: NormalizedMessage[]): number {
    let total = 0;
    for (const msg of normalized) {
      if (msg.kind !== 'tool_result') {
        total += 1;
      }
    }
    return total;
  }

  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    const normalizedOffset = Math.max(0, offset);
    const normalizedLimit = limit === null ? null : Math.max(0, limit);

    // Windowed request (open a conversation / scroll up): read only the tail of
    // the transcript instead of the whole file. The full read is reserved for an
    // explicit "Load all" (limit === null) so large sessions open instantly.
    if (normalizedLimit !== null) {
      try {
        // Over-read raw rows: normalization expands some rows (assistant
        // multi-block) and drops others (tool_result), so raw count != message
        // count. The 4x + 64 budget reliably yields >= the requested window.
        const budget = (normalizedOffset + normalizedLimit) * 4 + 64;
        const { messages: rawTail, reachedStart } = await getSessionTail(sessionId, budget);
        const normalized = this.normalizeRawMessages(rawTail, sessionId);

        const totalNormalized = normalized.length;
        const start = Math.max(0, totalNormalized - normalizedOffset - normalizedLimit);
        const end = Math.max(0, totalNormalized - normalizedOffset);
        const messages = normalized.slice(start, end);
        // The real total needs a full read; only report it when the tail already
        // spans the whole transcript. The UI hides the count when total is 0.
        const total = reachedStart ? this.countConversationMessages(normalized) : 0;
        const hasMore = !reachedStart || start > 0;

        return {
          messages, total, hasMore, offset: normalizedOffset, limit: normalizedLimit,
          context: deriveContextUsage(rawTail) ?? undefined,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[ClaudeProvider] Failed to load session tail ${sessionId}:`, message);
        return { messages: [], total: 0, hasMore: false, offset: normalizedOffset, limit: normalizedLimit };
      }
    }

    // Full read — "Load all".
    let result: ClaudeHistoryResult;
    try {
      result = await getSessionMessages(sessionId, null, 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ClaudeProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    const rawMessages = Array.isArray(result) ? result : (result.messages || []);
    const normalized = this.normalizeRawMessages(rawMessages, sessionId);
    const total = this.countConversationMessages(normalized);

    return {
      messages: normalized, total, hasMore: false, offset: 0, limit: null,
      context: deriveContextUsage(rawMessages) ?? undefined,
    };
  }
}
