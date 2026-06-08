#!/usr/bin/env node
//
// plugin:channel@agentchan — reverse-connect channel shim for agent-discovery.
//
// A dependency-free stdio MCP server. Claude spawns it at launch (loaded via
// --dangerously-load-development-channels plugin:channel@agentchan). The shim:
//
//   1. Speaks the minimal MCP subset over stdin/stdout (newline-delimited
//      JSON-RPC): answers `initialize` declaring capabilities.experimental
//      ['claude/channel']={}, answers `tools/list` with [], swallows other
//      requests/notifications. This is what makes claude route our
//      notifications/claude/channel messages into the live session as
//      <channel source="plugin:channel:channel" ...> blocks.
//
//   2. Dials OUT (no inbound port) to the agent-discovery daemon:
//        GET {AGENT_DISCOVERY_URL}/channel/connect?session=<sid>&label=<label>
//      with Authorization: Bearer <token>. The daemon holds this SSE stream
//      open and writes one JSON prompt per `data:` event. For each prompt the
//      shim emits notifications/claude/channel {content, meta} on stdout -> the
//      prompt lands in the live session.
//
//   3. Reconnects with backoff if the stream drops. Logs to stderr only. NEVER
//      crashes on bad input — a dead channel plugin makes claude go deaf
//      silently, so every path is guarded.
//
// Zero npm/bun install: pure Node stdlib (node:http / node:https). Ships ready
// to run after `git clone`.

import http from 'node:http'
import https from 'node:https'
import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// Identity & config (from env claude provides + env we define)
// ---------------------------------------------------------------------------

// claude passes the session id + project dir to channel plugins via env.
const SESSION_ID = process.env.CLAUDE_CODE_SESSION_ID || ''
// The session's working dir (PWD is the plugin's own cwd, not the session's).
const SESSION_CWD = process.env.CLAUDE_PROJECT_DIR || process.env.PWD || ''

const DAEMON_URL = (process.env.AGENT_DISCOVERY_URL || 'http://127.0.0.1:9301').replace(/\/+$/, '')
const TOKEN = process.env.AGENT_DISCOVERY_TOKEN || ''
const LABEL = process.env.AGENT_CHANNEL_LABEL || ''
// Optional owner/domain tag for peer fan-out filtering on aggregating daemons.
// The daemon reads `domain` on GET /channel/connect and stores it on the record.
const DOMAIN = process.env.AGENT_DOMAIN || ''

function log(msg) {
  try { process.stderr.write(`channel shim: ${msg}\n`) } catch {}
}

// ---------------------------------------------------------------------------
// Minimal stdio MCP server (newline-delimited JSON-RPC)
// ---------------------------------------------------------------------------

function writeFrame(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + '\n')
  } catch (e) {
    log(`stdout write failed: ${e}`)
  }
}

function reply(id, result) {
  writeFrame({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  writeFrame({ jsonrpc: '2.0', id, error: { code, message } })
}

// Emit one inbound prompt into the live claude session.
function injectPrompt(content, meta) {
  writeFrame({
    jsonrpc: '2.0',
    method: 'notifications/claude/channel',
    params: {
      content,
      meta: {
        user: 'central',
        origin: 'central',
        ...meta,
        ts: (meta && meta.ts) || new Date().toISOString(),
      },
    },
  })
}

// ---------------------------------------------------------------------------
// Interactive ask tool — agent -> operator question, answered from claudeui.
//
// The built-in AskUserQuestion only works against an attached terminal, so over
// the channel it hangs. This MCP tool round-trips instead: POST the question to
// the daemon (/channel/ask), block the tool call, and resolve it when the daemon
// pushes a `channel_answer` back down our SSE stream (operator answered in the
// GUI). Mirrors AskUserQuestion's input so claudeui renders the same picker.
// ---------------------------------------------------------------------------

const ASK_TOOL = {
  name: 'ask',
  description:
    "Ask the operator a multiple-choice question and wait for their answer. " +
    "USE THIS INSTEAD OF the built-in AskUserQuestion tool — this session is " +
    "driven over a channel with no interactive terminal, so AskUserQuestion " +
    "would hang. Returns the operator's selection(s).",
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: 'One or more questions to ask (usually one).',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The question text.' },
            header: { type: 'string', description: 'Short category label (<=12 chars).' },
            multiSelect: { type: 'boolean', description: 'Allow multiple selections.' },
            options: {
              type: 'array',
              description: '2-4 choices.',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  description: { type: 'string' },
                },
                required: ['label'],
              },
            },
          },
          required: ['question', 'options'],
        },
      },
    },
    required: ['questions'],
  },
}

// request_id -> { rpcId, timer }
const pendingAsks = new Map()
const ASK_TIMEOUT_MS = 30 * 60 * 1000 // 30 min — operator may be away

// POST JSON to the daemon. Resolves {ok, status, body}; never throws.
function postJson(pathname, body) {
  return new Promise(resolve => {
    let u
    try {
      u = new URL(`${DAEMON_URL}${pathname}`)
    } catch (e) {
      log(`postJson bad url: ${e}`)
      resolve({ ok: false, status: 0 })
      return
    }
    const lib = u.protocol === 'https:' ? https : http
    const data = Buffer.from(JSON.stringify(body))
    const headers = { 'Content-Type': 'application/json', 'Content-Length': data.length }
    if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`
    const req = lib.request(u, { method: 'POST', headers }, res => {
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', c => (buf += c))
      res.on('end', () =>
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: buf }))
    })
    req.on('error', e => {
      log(`postJson error: ${e}`)
      resolve({ ok: false, status: 0 })
    })
    req.write(data)
    req.end()
  })
}

// Render the operator's answer as a tool-result text the agent can act on.
function formatAnswer(questions, answers) {
  const a = answers && typeof answers === 'object' ? answers : {}
  const lines = []
  for (const q of Array.isArray(questions) ? questions : []) {
    const key = q && q.question
    const val = key && a[key]
    lines.push(`${key}\n→ ${val ? val : '(no selection / skipped)'}`)
  }
  if (!lines.length) return 'The operator did not provide an answer.'
  return `The operator answered:\n\n${lines.join('\n\n')}`
}

// Begin an ask: park the rpc id, POST the question to the daemon, arm a timeout.
async function startAsk(rpcId, questions) {
  const request_id = randomUUID()
  const timer = setTimeout(() => {
    if (!pendingAsks.has(request_id)) return
    pendingAsks.delete(request_id)
    reply(rpcId, {
      content: [{ type: 'text', text: 'No answer from the operator (timed out after 30 minutes).' }],
    })
  }, ASK_TIMEOUT_MS)
  if (timer.unref) timer.unref()
  pendingAsks.set(request_id, { rpcId, timer, questions })

  const res = await postJson('/channel/ask', { session: SESSION_ID, request_id, questions })
  if (!res.ok) {
    // Couldn't queue the question — unblock the tool with an error instead of hanging.
    const entry = pendingAsks.get(request_id)
    if (entry) {
      clearTimeout(entry.timer)
      pendingAsks.delete(request_id)
    }
    reply(rpcId, {
      content: [{ type: 'text', text: `Could not deliver the question to the operator (daemon HTTP ${res.status}).` }],
      isError: true,
    })
    return
  }
  log(`ask queued request_id=${request_id} (${(questions || []).length} question(s))`)
}

// Resolve a parked ask with the operator's answer (from a channel_answer SSE event).
function resolveAsk(request_id, answers) {
  const entry = pendingAsks.get(request_id)
  if (!entry) {
    log(`channel_answer for unknown request_id=${request_id}; ignored`)
    return
  }
  clearTimeout(entry.timer)
  pendingAsks.delete(request_id)
  reply(entry.rpcId, { content: [{ type: 'text', text: formatAnswer(entry.questions, answers) }] })
  log(`ask resolved request_id=${request_id}`)
}

function handleRpc(msg) {
  // Notifications have no id; requests do.
  const { id, method } = msg

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18',
      capabilities: {
        tools: {},
        experimental: {
          // Opt in to the channel notification surface. This is what lets our
          // notifications/claude/channel notifications reach the agent.
          'claude/channel': {},
        },
      },
      serverInfo: { name: 'channel', version: '0.1.0' },
      instructions: [
        'This is the agent-discovery channel. Prompts arrive as',
        '<channel source="plugin:channel:channel" ...> blocks, relayed from the',
        'central agent-discovery daemon (by an operator or claudeui), not a chat user.',
        '',
        'There is no outbound tool — replies are not delivered anywhere. Treat an',
        'inbound channel prompt as a direct instruction in this session and act on',
        'it; do not try to "respond to the sender".',
        '',
        'If the <channel> tag has an image_path attribute, Read that file — it is an',
        'image the operator attached to the message (additional images appear as',
        'image_path_1, image_path_2, ...). Other attachments use attachment_path /',
        'attachment_name / attachment_mime the same way.',
        '',
        'To ask the operator a multiple-choice question, ALWAYS use the `ask` tool',
        'from this server — NOT the built-in AskUserQuestion tool. This session has',
        'no interactive terminal, so AskUserQuestion will hang forever; `ask`',
        'round-trips the question to the operator and returns their selection.',
      ].join('\n'),
    })
    return
  }

  if (method === 'tools/list') {
    reply(id, { tools: [ASK_TOOL] })
    return
  }

  if (method === 'tools/call') {
    const name = msg.params && msg.params.name
    if (name === 'ask') {
      const args = (msg.params && msg.params.arguments) || {}
      const questions = Array.isArray(args.questions) ? args.questions : null
      if (!questions || !questions.length) {
        reply(id, {
          content: [{ type: 'text', text: "ask requires a non-empty 'questions' array" }],
          isError: true,
        })
        return
      }
      // Park + dispatch asynchronously; the reply happens when the operator answers
      // (or on timeout/error). Never throw out of the stdin handler.
      startAsk(id, questions).catch(e => {
        log(`startAsk failed (ignored): ${e}`)
        reply(id, {
          content: [{ type: 'text', text: `ask failed: ${e && e.message ? e.message : e}` }],
          isError: true,
        })
      })
      return
    }
    reply(id, {
      content: [{ type: 'text', text: `unknown tool: ${name}` }],
      isError: true,
    })
    return
  }

  if (method === 'ping') {
    reply(id, {})
    return
  }

  // Notifications (notifications/initialized, cancelled, etc.) — swallow.
  if (id === undefined || id === null) return

  // Unknown request — answer with method-not-found, never throw.
  replyError(id, -32601, `method not found: ${method}`)
}

// stdin frame reader (line-delimited). Guarded — bad lines are skipped.
let stdinBuf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  stdinBuf += chunk
  let nl
  while ((nl = stdinBuf.indexOf('\n')) >= 0) {
    const line = stdinBuf.slice(0, nl)
    stdinBuf = stdinBuf.slice(nl + 1)
    const t = line.trim()
    if (!t) continue
    let msg
    try {
      msg = JSON.parse(t)
    } catch (e) {
      log(`bad json frame skipped: ${e}`)
      continue
    }
    try {
      handleRpc(msg)
    } catch (e) {
      log(`handler error (ignored): ${e && e.stack ? e.stack : e}`)
    }
  }
})

// ---------------------------------------------------------------------------
// Outbound SSE connection to the daemon (server -> shim push)
// ---------------------------------------------------------------------------

let shuttingDown = false
let reconnectDelay = 1000 // ms, backoff up to 30s

function scheduleReconnect() {
  if (shuttingDown) return
  const delay = reconnectDelay
  reconnectDelay = Math.min(reconnectDelay * 2, 30000)
  log(`reconnecting to daemon in ${delay}ms`)
  setTimeout(connect, delay)
}

function connect() {
  if (shuttingDown) return
  if (!SESSION_ID) {
    log('no CLAUDE_CODE_SESSION_ID in env; cannot identify session. Retrying.')
    scheduleReconnect()
    return
  }

  const u = new URL(`${DAEMON_URL}/channel/connect`)
  u.searchParams.set('session', SESSION_ID)
  if (LABEL) u.searchParams.set('label', LABEL)
  if (SESSION_CWD) u.searchParams.set('cwd', SESSION_CWD)
  if (DOMAIN) u.searchParams.set('domain', DOMAIN)

  const lib = u.protocol === 'https:' ? https : http
  const headers = { Accept: 'text/event-stream' }
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`

  const req = lib.request(
    u,
    { method: 'GET', headers },
    res => {
      if (res.statusCode !== 200) {
        log(`daemon /channel/connect returned ${res.statusCode}; will retry`)
        res.resume()
        scheduleReconnect()
        return
      }
      log(`connected to daemon ${u.origin} for session ${SESSION_ID}`)
      reconnectDelay = 1000 // reset backoff on a good connect

      res.setEncoding('utf8')
      let buf = ''
      res.on('data', chunk => {
        buf += chunk
        // SSE events are separated by a blank line. Parse complete events.
        let sep
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const rawEvent = buf.slice(0, sep)
          buf = buf.slice(sep + 2)
          const dataLines = []
          for (const line of rawEvent.split('\n')) {
            if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
            // ignore `event:`, `id:`, comments (`:`), etc.
          }
          if (!dataLines.length) continue
          const dataStr = dataLines.join('\n')
          let payload
          try {
            payload = JSON.parse(dataStr)
          } catch (e) {
            log(`bad SSE data skipped: ${e}`)
            continue
          }
          // Daemon control events vs prompts.
          if (payload && payload.type === 'hello') {
            log(`daemon hello: agent_id=${payload.agent_id || '?'}`)
            continue
          }
          if (payload && payload.type === 'ping') continue
          // Operator's answer to a parked `ask` tool call.
          if (payload && payload.type === 'channel_answer') {
            try {
              resolveAsk(payload.request_id, payload.answers)
            } catch (e) {
              log(`resolveAsk failed (ignored): ${e}`)
            }
            continue
          }
          const content = payload && typeof payload.content === 'string' ? payload.content : null
          if (!content) {
            log('SSE event without content; ignored')
            continue
          }
          const meta = (payload && typeof payload.meta === 'object' && payload.meta) || {}
          try {
            injectPrompt(content, meta)
            log(`injected ${Buffer.byteLength(content)}B prompt into live session`)
          } catch (e) {
            log(`inject failed (ignored): ${e}`)
          }
        }
      })
      res.on('end', () => {
        log('daemon SSE stream ended')
        scheduleReconnect()
      })
      res.on('error', e => {
        log(`daemon SSE stream error: ${e}`)
        scheduleReconnect()
      })
    },
  )
  req.on('error', e => {
    log(`daemon connect error: ${e}`)
    scheduleReconnect()
  })
  req.end()
}

// ---------------------------------------------------------------------------
// Lifecycle — die cleanly when claude closes stdin
// ---------------------------------------------------------------------------

function shutdown(reason) {
  if (shuttingDown) return
  shuttingDown = true
  log(`shutting down (${reason})`)
  process.exit(0)
}

process.stdin.on('end', () => shutdown('stdin EOF'))
process.stdin.on('close', () => shutdown('stdin closed'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('uncaughtException', e => log(`uncaughtException (ignored): ${e && e.stack ? e.stack : e}`))
process.on('unhandledRejection', e => log(`unhandledRejection (ignored): ${e}`))

log(`starting. session=${SESSION_ID || 'UNKNOWN'} cwd=${SESSION_CWD || '?'} daemon=${DAEMON_URL} token=${TOKEN ? 'set' : 'MISSING'} label=${LABEL || 'NONE'}`)

// Channel registration is OPT-IN: only dial the agent-discovery daemon when this
// session was explicitly launched as a managed agent (AGENT_CHANNEL_LABEL set).
// Otherwise this is just an ordinary Claude session that happens to load the
// globally-enabled plugin — e.g. a CCUI Projects/SDK session spawned inside an
// agent's working folder. Such sessions must NOT register: doing so creates a
// stray "unnamed" agent in the folder and (same cwd) collides with / steals the
// real live agent's record. No label → load as a harmless no-op MCP server.
if (LABEL) {
  connect()
} else {
  log('no AGENT_CHANNEL_LABEL — not registering with the daemon (channel is opt-in)')
}
