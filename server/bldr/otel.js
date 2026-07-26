/**
 * Opt-in OpenTelemetry tracing for the BLDR generation fan-out.
 *
 * - OFF unless BLDR_OTEL=1 (systemd drop-in otel.conf) — and even then it
 *   no-ops gracefully if the OTel libs aren't installed or the collector is
 *   unreachable. Tracing must never break or slow production.
 * - Ships OTLP/HTTP to the shared collector → Tempo on the monitoring network
 *   (BLDR_OTEL_ENDPOINT, default http://10.10.0.1:4318).
 * - Span attributes are METADATA ONLY (model, tokens, latency, brief hash).
 *   Full prompt/brief text is attached only when BLDR_OTEL_DEBUG=1.
 */

const ENABLED = process.env.BLDR_OTEL === '1';
const ENDPOINT = process.env.BLDR_OTEL_ENDPOINT || 'http://10.10.0.1:4318';
export const OTEL_DEBUG_TEXT = process.env.BLDR_OTEL_DEBUG === '1';

let initPromise = null;

async function init() {
  if (!ENABLED) return null;
  try {
    const [api, sdk, exporterMod, resources] = await Promise.all([
      import('@opentelemetry/api'),
      import('@opentelemetry/sdk-trace-base'),
      import('@opentelemetry/exporter-trace-otlp-http'),
      import('@opentelemetry/resources'),
    ]);
    const makeResource =
      resources.resourceFromAttributes || ((attrs) => new resources.Resource(attrs));
    const provider = new sdk.BasicTracerProvider({
      resource: makeResource({ 'service.name': 'bti-bldr' }),
      spanProcessors: [
        new sdk.BatchSpanProcessor(new exporterMod.OTLPTraceExporter({ url: `${ENDPOINT}/v1/traces` })),
      ],
    });
    console.log(`[bldr-otel] tracing ON → ${ENDPOINT} (service.name=bti-bldr)`);
    return {
      provider,
      tracer: provider.getTracer('bldr'),
      trace: api.trace,
      context: api.context,
      SpanStatusCode: api.SpanStatusCode,
    };
  } catch (err) {
    console.warn('[bldr-otel] BLDR_OTEL=1 but tracing is a no-op:', err?.message || err);
    return null;
  }
}

/** The otel bundle, or null when disabled/unavailable. Lazy, initialized once. */
export function getOtel() {
  if (!initPromise) initPromise = init();
  return initPromise;
}

/** Fire-and-forget flush so short-lived runs show up in Tempo promptly. */
export function flushOtel() {
  (initPromise || Promise.resolve(null)).then((o) => o?.provider.forceFlush()).catch(() => {});
}
