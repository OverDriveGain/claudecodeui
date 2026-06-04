import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { getConnectableHost, normalizeLoopbackHost } from './shared/networkHosts.js'

export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, process.cwd(), '')

  const configuredHost = env.HOST || '0.0.0.0'
  // if the host is not a loopback address, it should be used directly. 
  // This allows the vite server to EXPOSE all interfaces when the host 
  // is set to '0.0.0.0' or '::', while still using 'localhost' for browser 
  // URLs and proxy targets.
  const host = normalizeLoopbackHost(configuredHost)
  
  const proxyHost = getConnectableHost(configuredHost)
  // TODO: Remove support for legacy PORT variables in all locations in a future major release, leaving only SERVER_PORT.
  const serverPort = env.SERVER_PORT || env.PORT || 3001

  // When the dev server is exposed through a reverse proxy / tunnel on a public
  // hostname (e.g. running `vite` behind Cloudflare for a live dev deployment),
  // Vite rejects the request unless the Host is allow-listed, and the HMR
  // websocket must be told the public wss endpoint. All env-driven, so this is a
  // no-op for ordinary localhost dev.
  // VITE_ALLOWED_HOSTS: comma-separated hostnames, or "all" to allow any.
  const allowedHostsEnv = (env.VITE_ALLOWED_HOSTS || '').trim()
  const allowedHosts = allowedHostsEnv === 'all'
    ? true
    : (allowedHostsEnv ? allowedHostsEnv.split(',').map((h) => h.trim()).filter(Boolean) : undefined)
  // VITE_HMR_HOST set => point the HMR client at the public proxied endpoint.
  const hmr = env.VITE_HMR_HOST
    ? {
        host: env.VITE_HMR_HOST,
        protocol: env.VITE_HMR_PROTOCOL || 'wss',
        clientPort: parseInt(env.VITE_HMR_CLIENT_PORT) || 443,
      }
    : undefined

  // Vite 7 gates the dev server (incl. the HMR websocket) on the request
  // Origin via `server.cors.origin`, which defaults to localhost-only. When the
  // dev server is exposed on a public hostname behind a reverse proxy, a real
  // browser sends `Origin: https://<public host>` and Vite answers 400 to the
  // HMR ws upgrade -> no hot reload. So when a public host is configured
  // (VITE_HMR_HOST, or https hosts listed in VITE_ALLOWED_HOSTS), allow those
  // origins IN ADDITION to Vite's default localhost regex. No-op for plain
  // localhost dev (cors stays undefined => Vite's secure default).
  const defaultLocalhostOrigins = /^https?:\/\/(?:(?:[^:]+\.)?localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/
  const publicHostOrigins = []
  if (env.VITE_HMR_HOST) {
    const proto = env.VITE_HMR_PROTOCOL || 'wss'
    const scheme = proto === 'wss' || proto === 'https' ? 'https' : 'http'
    publicHostOrigins.push(`${scheme}://${env.VITE_HMR_HOST}`)
  }
  if (allowedHostsEnv && allowedHostsEnv !== 'all') {
    for (const h of allowedHostsEnv.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (h === 'localhost') continue
      publicHostOrigins.push(`https://${h}`, `http://${h}`)
    }
  }
  const cors = publicHostOrigins.length
    ? { origin: [defaultLocalhostOrigins, ...new Set(publicHostOrigins)] }
    : undefined

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    server: {
      host,
      port: parseInt(env.VITE_PORT) || 5173,
      ...(allowedHosts !== undefined ? { allowedHosts } : {}),
      ...(hmr ? { hmr } : {}),
      ...(cors ? { cors } : {}),
      proxy: {
        '/api': `http://${proxyHost}:${serverPort}`,
        '/ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        '/shell': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        }
      }
    },
    build: {
      outDir: 'dist',
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-react': ['react', 'react-dom', 'react-router-dom'],
            'vendor-codemirror': [
              '@uiw/react-codemirror',
              '@codemirror/lang-css',
              '@codemirror/lang-html',
              '@codemirror/lang-javascript',
              '@codemirror/lang-json',
              '@codemirror/lang-markdown',
              '@codemirror/lang-python',
              '@codemirror/theme-one-dark'
            ],
            'vendor-xterm': ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-clipboard', '@xterm/addon-webgl']
          }
        }
      }
    }
  }
})
