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
      ].join('\n'),
    })
    return
  }

  if (method === 'tools/list') {
    reply(id, { tools: [] })
    return
  }

  if (method === 'tools/call') {
    reply(id, {
      content: [{ type: 'text', text: 'channel shim exposes no tools' }],
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

log(`starting. session=${SESSION_ID || 'UNKNOWN'} cwd=${SESSION_CWD || '?'} daemon=${DAEMON_URL} token=${TOKEN ? 'set' : 'MISSING'}`)
connect()
