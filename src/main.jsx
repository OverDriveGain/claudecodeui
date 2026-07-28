import React from 'react'
import ReactDOM from 'react-dom/client'
// Install the native network shim BEFORE anything issues a request. On the web
// build this is a no-op; in the Capacitor apps it redirects relative /api and
// WebSocket calls to the user-configured remote CCUI server.
import { installNetworkShim } from './mobile/networkShim'
installNetworkShim()
import { initNativeShell } from './mobile/nativeShell'
// Adopt a ?brief= handed over by the BTI website design wizard before the app
// renders (stored once, stripped from the URL, prefills the chat composer).
import { adoptUrlBrief } from './utils/incomingBrief'
import App from './App.tsx'
import './index.css'
import 'katex/dist/katex.min.css'

// Initialize i18n
import './i18n/config.js'

// Native-only shell integration (status bar, keyboard, hardware back button).
initNativeShell()
adoptUrlBrief()

// Register service worker for PWA + Web Push support.
// When a new build ships, the new SW activates (skipWaiting) and takes control,
// firing `controllerchange`. Reload once on that event so an already-open tab
// picks up the fresh bundle instead of running the previous one indefinitely.
// Guarded so it never reloads on the first-ever install or loops.
// Skip the service worker inside the native apps: content updates ship with the
// app binary, and a SW on the local webview scheme only risks stale caching.
if ('serviceWorker' in navigator && !window.Capacitor?.isNativePlatform?.()) {
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded || !hadController) return; // skip first install; reload only on update
    reloaded = true;
    window.location.reload();
  });
  navigator.serviceWorker
    .register('/sw.js')
    .then(reg => reg.update().catch(() => {})) // poll for an updated SW on each load
    .catch(err => {
      console.warn('Service worker registration failed:', err);
    });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
