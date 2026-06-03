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
