# MyMu — native iOS client

A native SwiftUI client for MyMu (this CCUI product). **No webview** — it talks
to the same REST + `/ws` API the web app uses, pointed at a configurable server
(default `https://code.kaxtus.com`).

Two shipping targets share this code:
- **Standalone** MyMu app (this project).
- **Integrated**: the chat surface is reused as the Chat tab in the mymu-voice
  (`~/Projects/multibrain`) app, replacing its old WKWebView tab.

## Layout
```
ios-native/
  project.yml            # XcodeGen spec (the .xcodeproj is generated, not committed)
  MyMu/
    App/MyMuApp.swift     # @main
    Core/
      Config.swift        # server origin + WS/file URLs
      Keychain.swift      # auth-token storage
      Models.swift        # Project / Session / ChatMessage (mirror NormalizedMessage)
      APIClient.swift     # REST: login, projects, history
      RelayClient.swift   # /ws: subscribe, stream, send, permissions, abort
      AppState.swift      # auth + session (ObservableObject)
    Views/
      RootView / LoginView / ProjectsView / ConversationsView / ChatView / MessageRow
```

## Server contract (all existing endpoints — no new backend)
- `POST /api/auth/login` `{username,password}` → `{token,user}`
- `GET  /api/projects` → projects incl. virtual `remote:<id>` agents
- `GET  /api/providers/sessions/:id/messages?limit&offset` → normalized history
- `WS   /ws?token=<jwt>` — send `rc-subscribe`, `claude-command`
  (`options.remoteControl=<sessionId>` for agents), `claude-permission-response`,
  `abort-session`; consume `kind`-tagged NormalizedMessage frames.

## Build (from berlin, over SSH to the fleet Mac)
```bash
rsync -a --delete ios-native/ manar@192.168.0.165:~/mymu-ios/
ssh manar@192.168.0.165 '
  export DEVELOPER_DIR=/Applications/Xcode-15.2.0.app/Contents/Developer
  cd ~/mymu-ios && ~/xcodegen-dist/xcodegen/bin/xcodegen generate &&
  xcodebuild -project MyMu.xcodeproj -scheme MyMu -sdk iphonesimulator \
    -destination "generic/platform=iOS Simulator" -derivedDataPath /tmp/mymu-dd \
    CODE_SIGNING_ALLOWED=NO build'      # simulator compile check — no signing
```
Device install needs signing (keychain unlock + DEVELOPMENT_TEAM 7276Y3726M) — see
`~/Projects/multibrain/CHAT_HANDOFF_FOR_CCUI.md` §3 for the device pipeline.

## Status — v1 in progress
Done: login, projects/agents list, conversations, chat (history + live streaming +
send + permission prompts), simulator build green.
Next: richer rendering (inline media, structured tool panels, thinking), scroll-away
awareness, local-session send, standalone app icon/launch, then device install.
