# OpenTelemetry tracing for BLDR generations

One request fans out into 5 LLM calls (4 drawing panes + costs). With tracing on,
each generation appears in Tempo as a tree: a `bldr.generate` parent span with one
`llm.<pane>` child per call, carrying GenAI attributes (`gen_ai.system`,
`gen_ai.request.model`, `gen_ai.usage.input_tokens`/`output_tokens` where the
backend reports usage), `bldr.latency_ms`, and span status = error on failures.

## Design rules

- **Opt-in**: dead code unless `BLDR_OTEL=1`. Off flag, missing libs, or an
  unreachable collector all degrade to a silent no-op — tracing can never take
  the app down.
- **Metadata only**: span attributes carry token counts, model, latency, and a
  sha256 prefix of the brief — never prompt/response text. `BLDR_OTEL_DEBUG=1`
  (debug only) adds truncated prompt text.
- Deps live in `optionalDependencies` (`@opentelemetry/api`, `sdk-trace-base`,
  `exporter-trace-otlp-http`, `resources`); a failed install of them doesn't
  break `npm install`.

## Wiring

- Code: `server/bldr/otel.js` (init/no-op) + spans in `server/bldr/generate.js`.
- Transport: OTLP/HTTP to `BLDR_OTEL_ENDPOINT` (default `http://10.10.0.1:4318`,
  the shared collector → Tempo, reachable from box over WireGuard).
- Enable: copy `otel.conf` to
  `~/.config/systemd/user/bti-webapp-ccui-dev.service.d/otel.conf`, then
  `systemctl --user daemon-reload && systemctl --user restart bti-webapp-ccui-dev`
  (don't restart while a generation is running — jobs are in-memory).
- Service name in Tempo: **`bti-bldr`**.
