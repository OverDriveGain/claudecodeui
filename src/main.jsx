import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import 'katex/dist/katex.min.css'

// Initialize i18n
import './i18n/config.js'

// Register service worker for PWA + Web Push support.
// When a new build ships, the new SW activates (skipWaiting) and takes control,
// firing `controllerchange`. Reload once on that event so an already-open tab
// picks up the fresh bundle instead of running the previous one indefinitely.
// Guarded so it never reloads on the first-ever install or loops.
if ('serviceWorker' in navigator) {
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
