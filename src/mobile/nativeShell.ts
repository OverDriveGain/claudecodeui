/**
 * Native shell integration for the Capacitor apps.
 *
 * Everything here is dynamically imported and guarded by `isNativeMobile()` so
 * the web build never loads the Capacitor plugins. Handles the status bar,
 * the software keyboard resize behaviour, and the Android hardware back button.
 */

import { isNativeMobile } from './serverConfig';

export function initNativeShell(): void {
  if (!isNativeMobile()) return;

  // Mark the DOM so CSS can apply native-only tweaks (safe areas, no-select).
  try {
    document.documentElement.classList.add('native-mobile');
  } catch {
    /* ignore */
  }

  void (async () => {
    try {
      const { StatusBar, Style } = await import('@capacitor/status-bar');
      await StatusBar.setStyle({ style: Style.Dark }).catch(() => {});
      // Draw the webview under the status bar so our own header owns the space.
      await StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {});
    } catch {
      /* status-bar plugin not present on this platform */
    }

    try {
      const { Keyboard, KeyboardResize } = await import('@capacitor/keyboard');
      // The app already tracks visualViewport for the composer; native resize
      // keeps the layout viewport correct on both platforms.
      await Keyboard.setResizeMode({ mode: KeyboardResize.Native }).catch(() => {});
    } catch {
      /* keyboard plugin not present */
    }

    try {
      const { App } = await import('@capacitor/app');
      App.addListener('backButton', ({ canGoBack }) => {
        if (canGoBack || window.history.length > 1) {
          window.history.back();
        } else {
          void App.exitApp();
        }
      });
    } catch {
      /* app plugin not present */
    }
  })();
}
