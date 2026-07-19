import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor configuration for the MyMu mobile apps (Android + iOS).
 *
 * The apps bundle the existing web client (`dist/`) and run it in a native
 * webview. All API/WebSocket traffic is redirected at runtime to a
 * user-configured remote CCUI server by `src/mobile/networkShim.ts`, so the app
 * is a thin native shell around the real web product — nothing is duplicated.
 *
 * Build the web assets first (`npm run build:mobile`) then `npx cap sync`.
 */
const config: CapacitorConfig = {
  appId: 'com.mymu.app',
  appName: 'MyMu',
  webDir: 'dist',
  backgroundColor: '#222222',
  android: {
    // Allow the WebView to talk to https servers (default). No cleartext.
    allowMixedContent: false,
  },
  ios: {
    contentInset: 'always',
  },
  plugins: {
    Keyboard: {
      resizeOnFullScreen: true,
    },
  },
};

export default config;
