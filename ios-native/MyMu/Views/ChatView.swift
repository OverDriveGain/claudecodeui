import SwiftUI
import UIKit
import PhotosUI
import UniformTypeIdentifiers

/// A file staged in the composer, ready to send as `options.images`.
struct PendingAttachment: Identifiable, Equatable {
    let id = UUID()
    let name: String
    let dataURL: String
    let isImage: Bool
}

struct ChatView: View {
    let sessionId: String
    let projectId: String
    let isRemote: Bool
    let title: String
    /// Agent→host pinning: host origin + token this conversation is routed to
    /// (nil = active account's host). Set when the agent is assigned to another
    /// host the app has a saved login for.
    let origin: String?
    private let chatToken: String
    /// Pinned to a host with NO saved login: label shown by the composer's
    /// file warning ("log in to <host> to share files"). nil = files work.
    let pinnedHostNeedingLogin: String?

    @EnvironmentObject var appState: AppState
    @StateObject private var relay: RelayClient
    @State private var loadError: String?
    @State private var loadingHistory = true
    @State private var atBottom = true
    // Follow-mode = the user's INTENT to ride the bottom. Only an explicit upward
    // drag turns it off; reaching the bottom (any way), sending, or tapping the
    // pill turns it back on. Deriving intent from sentinel visibility alone made
    // following stop whenever content growth pushed the sentinel away (the old
    // flakiness), so intent and position are tracked separately now.
    @State private var followMode = true
    // Phantom-gap guard: the content bottom may never REST above the viewport
    // bottom (that's the "conversation looks blank until I scroll" bug — content
    // shrinks after we pinned the bottom, or an animated pin overshoots into
    // LazyVStack estimated space: end-of-turn reconcile, media rows resizing,
    // keyboard open/close). Measured from the WHOLE content block's frame — the
    // old bottom-sentinel row could be dropped by the lazy container exactly in
    // the over-scrolled state, which cancelled the repair and left the chat
    // blank until a manual scroll (the "chat disappears after I send" bug).
    @State private var contentBottom: CGFloat = .greatestFiniteMagnitude
    @State private var viewportHeight: CGFloat = 0
    @State private var contentHeight: CGFloat = 0
    @State private var gapRepair: Task<Void, Never>?
    /// Bumped by the composer right before a send — the transcript pins itself
    /// to the bottom across the frames the send mutation needs to lay out.
    @State private var sendPin = 0
    /// While set (send + ~0.6s), the instant revision/viewport pins stand down so
    /// the one animated glide to the bottom is actually visible — the Claude-app
    /// send feel: the new bubble lands, then the view glides down, no teleport.
    @State private var glideUntil = Date.distantPast
    @State private var revisionScrollPending = false
    /// False until the opening transcript is pinned to the bottom — content is
    /// hidden (loader shown) so the settling scroll is never visible.
    @State private var revealed = false
    @Environment(\.scenePhase) private var scenePhase
    private let previewMessages: [ChatMessage]?

    init(sessionId: String, projectId: String, isRemote: Bool, title: String, token: String,
         projectPath: String? = nil, previewMessages: [ChatMessage]? = nil,
         origin: String? = nil, pinnedHostNeedingLogin: String? = nil) {
        self.sessionId = sessionId
        self.projectId = projectId
        self.isRemote = isRemote
        self.title = title
        self.previewMessages = previewMessages
        self.origin = origin
        self.chatToken = token
        self.pinnedHostNeedingLogin = pinnedHostNeedingLogin
        _relay = StateObject(wrappedValue: RelayClient(token: token, sessionId: sessionId,
                                                       isRemote: isRemote, projectPath: projectPath,
                                                       origin: origin))
    }

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            VStack(spacing: 0) {
                messagesList
                if let p = relay.pendingPermission { permissionBanner(p) }
                // The composer is its OWN view owning the draft text: a keystroke
                // re-renders only this small view, never the transcript. When the
                // whole chat re-rendered per keystroke, the visible-message filter
                // walked every message's content — typing crawled in conversations
                // with megabyte transcripts.
                ChatComposer(relay: relay, pinnedHostNeedingLogin: pinnedHostNeedingLogin,
                             onWillSend: { followMode = true; sendPin += 1 })
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.background, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar {
            // Agent name over its token count — the standard two-line inline
            // title. The meter used to sit in the trailing group next to Files,
            // where it competed with the title for the same row, so a long agent
            // name pushed it onto a second line. As a subtitle it owns its own
            // row and the name gets the full width back.
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(title)
                        .font(.headline)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    if let ctx = relay.context {
                        ContextMeter(usage: ctx)
                    }
                }
            }
            ToolbarItem(placement: .navigationBarTrailing) {
                NavigationLink {
                    FilesView(projectId: projectId, token: chatToken, title: title, origin: origin)
                } label: {
                    Image(systemName: "folder").foregroundColor(Theme.primary)
                }
            }
        }
        .task {
            RecentlyViewedStore.shared.record(sessionId: sessionId, projectId: projectId,
                                              isRemote: isRemote, title: title)
            await start()
        }
        // Agent already working when the chat opens (or a turn starts silently):
        // check the live status endpoint now and every 10s as a backstop.
        .task {
            guard isRemote else { return }
            while !Task.isCancelled {
                await relay.syncRunningState(APIClient(token: chatToken, origin: origin))
                try? await Task.sleep(nanoseconds: 10_000_000_000)
            }
        }
        // Returning from the background: the socket iOS killed still LOOKS open,
        // so without this kick the chat sat stale until the next failed I/O plus
        // the reconnect backoff. Reconnect + reconcile + status sync right away.
        .onChange(of: scenePhase) { phase in
            guard phase == .active, previewMessages == nil else { return }
            relay.ensureConnected()
            Task { await relay.syncRunningState(APIClient(token: chatToken, origin: origin)) }
        }
        .onDisappear { relay.disconnect() }
    }

    private var messagesList: some View {
        GeometryReader { outer in
        ScrollViewReader { proxy in
            ScrollView {
                // NON-lazy on purpose (Manar's diagnosis, 2026-07-25): LazyVStack
                // only ESTIMATES unmeasured row heights, and bash/tool rows are
                // far taller than the estimate — at certain scroll offsets it
                // decided a visible message was off-screen and un-rendered it
                // ("messages hide when I scroll"), and every scrollTo landed in
                // estimated space (the overshoot family of bugs). A plain VStack
                // measures ALL rows up front: nothing hides, every scroll targets
                // real layout. History is capped (~200 rows) and MessageRow is
                // .equatable(), so the one-time layout cost is small and masked
                // by the reveal loader.
                VStack(alignment: .leading, spacing: 18) {
                    if loadingHistory {
                        MyMuLoader().frame(maxWidth: .infinity).padding(.top, 24)
                    }
                    if let loadError {
                        Text(loadError).font(.footnote).foregroundColor(Theme.danger)
                    }
                    ForEach(visibleMessages) { m in
                        MessageRow(message: m, projectId: projectId, token: chatToken,
                                   origin: origin, showActions: m.id == lastAssistantTextId)
                            .equatable()
                            .id(m.id)
                    }
                    // Bottom anchor for scrollTo. Its onAppear/onDisappear no longer
                    // mean anything in a NON-lazy VStack (every row "appears" once
                    // and never disappears), so bottom-ness is derived from the
                    // content frame geometry in onPreferenceChange below.
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                // Bottom-align SHORT transcripts: force the content at least as tall
                // as the viewport and bottom-align it, so a few messages rest on the
                // composer instead of floating at the top. defaultScrollAnchor alone
                // does not do this — it only positions OVERFLOWING content.
                .frame(maxWidth: .infinity, minHeight: viewportHeight, alignment: .bottomLeading)
                // The whole content block's frame in scroll-viewport space: its
                // height (short-transcript alignment) AND where its bottom edge
                // sits (the gap guard). Always measured — unlike a lazy row, this
                // background can't be recycled away in the over-scrolled state.
                .background(GeometryReader { g in
                    Color.clear.preference(key: ContentFrameKey.self,
                                           value: g.frame(in: .named("chatScroll")))
                })
            }
            // Native bottom anchoring for LONG transcripts: the scroll rests at the
            // true bottom on open and sticks there as content grows or shrinks, which
            // is what the manual scrollTo/settle timers were approximating.
            .defaultScrollAnchor(.bottom)
            .coordinateSpace(name: "chatScroll")
            .onAppear { viewportHeight = outer.size.height }
            .onChange(of: outer.size.height) { h in
                let delta = h - viewportHeight
                viewportHeight = h
                guard followMode, abs(delta) > 8 else { return }
                if delta < -60 {
                    // Keyboard OPENING: ride the system animation with ONE
                    // animated pin — repeated instant snaps mid-animation yanked
                    // the transcript up "in a flaky way". A silent correction
                    // after the animation settles catches any drift.
                    withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo("bottom", anchor: .bottom) }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
                        if followMode { proxy.scrollTo("bottom", anchor: .bottom) }
                    }
                } else if delta > 60 {
                    // Keyboard DISMISSING (viewport grows): a single scrollTo
                    // loses the race against the inset animation and the view
                    // settles over-scrolled (blank strip below the last message,
                    // "have to scroll up") — re-pin across the animation frames.
                    settleToBottom(proxy)
                } else {
                    // Composer grew/shrank a line or two (typing wraps, clearing
                    // on send, attachment chips). These small deltas used to be
                    // ignored, hiding the transcript's last lines behind the
                    // composer — one instant pin plus a settle correction keeps
                    // the bottom flush without animation storms. During a send
                    // glide, stand down: the glide (+ its correction) owns this.
                    guard Date() >= glideUntil else { return }
                    proxy.scrollTo("bottom", anchor: .bottom)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                        if followMode { proxy.scrollTo("bottom", anchor: .bottom) }
                    }
                }
            }
            .onPreferenceChange(ContentFrameKey.self) { frame in
                contentHeight = frame.height
                contentBottom = frame.maxY
                // Geometry-derived bottom-ness (replaces the lazy sentinel's
                // appear/disappear): at bottom ⇔ the content's bottom edge sits
                // at/inside the viewport. Reaching it re-arms follow-mode, same
                // as the sentinel's onAppear used to.
                let nearBottom = frame.maxY <= viewportHeight + 24
                if nearBottom != atBottom {
                    atBottom = nearBottom
                    if nearBottom { followMode = true }
                }
                scheduleGapRepair(proxy)
            }
            // Send = one smooth glide (Claude-app feel): a beat for the new bubble
            // to lay out, then a short eased scroll — never an instant teleport.
            // A silent correction at the end catches composer-collapse/keyboard
            // drift; the gap guard backstops any overshoot beyond that.
            .onChange(of: sendPin) { _ in
                glideUntil = Date().addingTimeInterval(0.6)
                // 0.16s (was 0.08): the optimistic bubble AND the composer
                // collapse need a beat to lay out — gliding earlier targets a
                // bottom that still moves, overshooting past the conversation.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.16) {
                    withAnimation(.easeOut(duration: 0.3)) { proxy.scrollTo("bottom", anchor: .bottom) }
                }
                // The eased glide over a LazyVStack overshoots into ESTIMATED row
                // space — a blank strip under the new bubble. Correct silently the
                // moment the animation lands (0.16 + 0.3 = 0.46s), again shortly
                // after, and once more when composer collapse + keyboard insets
                // have fully settled.
                for delay in [0.5, 0.7, 0.95] {
                    DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                        if followMode { proxy.scrollTo("bottom", anchor: .bottom) }
                    }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            // An explicit upward drag is the ONE gesture that means "stop following".
            // 24pt: a real "scroll up to read" clears it instantly, but the finger
            // wobble of a tap or an interactive keyboard-dismiss drag doesn't —
            // a 12pt trigger disarmed following almost every touch, so replies
            // streamed in below the fold ("chat scrolled away after I sent").
            .simultaneousGesture(
                DragGesture().onChanged { v in
                    if v.translation.height > 24 { followMode = false }
                }
            )
            // Follow content mutations (stream chunks included) with a SHORT DELAY,
            // never instantly: an immediate scrollTo fires before the just-appended
            // row has real layout, so it lands in LazyVStack ESTIMATED space and
            // overshoots past the conversation — worst with tall bash/tool blocks.
            // The 0.12s beat lets the row lay out first; bursts coalesce into one
            // scheduled scroll; a 0.35s silent correction catches late resizes.
            // During a send glide the follow stands down (the glide owns it).
            .onChange(of: relay.revision) { _ in
                guard followMode, Date() >= glideUntil else { return }
                if revisionScrollPending { return }
                revisionScrollPending = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {
                    revisionScrollPending = false
                    guard followMode, Date() >= glideUntil else { return }
                    proxy.scrollTo("bottom", anchor: .bottom)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                        if followMode, Date() >= glideUntil {
                            proxy.scrollTo("bottom", anchor: .bottom)
                        }
                    }
                }
            }
            // Initial jump after history load: lazy row heights settle over several
            // frames, so re-pin the bottom a few times, non-animated. The transcript
            // stays INVISIBLE (opacity 0 + loader) while that happens — the user
            // must never watch the view "scroll fast to the bottom"; it appears
            // already sitting on the last message (the iMessage open behavior).
            .onChange(of: loadingHistory) { loading in
                if !loading {
                    settleToBottom(proxy)
                    // Reveal on first bottom contact (sentinel appears) — see
                    // .onChange(atBottom) — with a hard fallback so an odd layout
                    // can never leave the chat permanently hidden.
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { revealed = true }
                }
            }
            .onChange(of: atBottom) { isAtBottom in
                if isAtBottom && !loadingHistory { revealed = true }
            }
            .opacity(revealed ? 1 : 0)
            .overlay {
                if !revealed {
                    MyMuLoader().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            // STICKY working indicator: floats over the transcript just above the
            // composer. As a transcript ROW it changed content height on appear
            // (below the fold — you had to scroll to see it) and on removal at
            // turn end (one of the blank-gap causes). An overlay shifts nothing.
            .overlay(alignment: .bottom) {
                if relay.isLoading && !loadingHistory && revealed {
                    HStack(spacing: 8) {
                        MyMuLoader()
                        // Live activity — what the agent is doing right now,
                        // derived from the newest transcript frame. A long turn
                        // reads as motion, not a frozen loader.
                        Text(turnActivity + "…")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(Theme.text.opacity(0.75))
                            .lineLimit(1)
                        if let t = relay.turnStartedAt {
                            TimelineView(.periodic(from: t, by: 1)) { ctx in
                                Text("· " + Self.elapsedLabel(from: t, to: ctx.date))
                                    .font(.system(size: 12, design: .monospaced))
                                    .foregroundColor(Theme.mutedText)
                            }
                        }
                        if let tok = relay.turnTokens, tok > 0 {
                            Text("· \(Self.tokensLabel(tok)) tokens")
                                .font(.system(size: 12, design: .monospaced))
                                .foregroundColor(Theme.mutedText)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 5)
                    .background(Theme.background.opacity(0.85))
                    .clipShape(Capsule())
                    .padding(.bottom, 8)
                    .transition(.opacity)
                    .allowsHitTesting(false)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if !atBottom && revealed {
                    Button {
                        followMode = true
                        // NON-animated + settled: an animated long jump over the
                        // LazyVStack overshoots into estimated row space — the
                        // "big gap at the bottom after scrolling back down". The
                        // settle re-pins as the real row heights resolve.
                        settleToBottom(proxy)
                    } label: {
                        Image(systemName: "arrow.down")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundColor(Theme.text)
                            .frame(width: 36, height: 36)
                            .background(Theme.elevated)
                            .clipShape(Circle())
                            .overlay(Circle().stroke(Theme.border, lineWidth: 1))
                            .shadow(color: .black.opacity(0.35), radius: 6, y: 2)
                    }
                    .padding(.trailing, 16)
                    .padding(.bottom, 10)
                }
            }
        }
        }
    }

    /// True when the transcript's bottom edge is resting visibly above the fold
    /// while there is enough content to fill the screen — a phantom blank strip
    /// (over-scrolled past the end). Reading history puts the bottom BELOW the
    /// fold (maxY > viewport), so this can never fire on a user who scrolled up.
    private var hasPhantomGap: Bool {
        viewportHeight > 0
            && contentHeight > viewportHeight + 1
            && contentBottom < viewportHeight - 8
    }

    /// Debounced repair: rubber-band bounces and in-flight layout put the
    /// sentinel above the fold transiently, so only a gap that SURVIVES ~½s is
    /// real. scrollTo just clamps to the true bottom — a no-op when legitimate.
    private func scheduleGapRepair(_ proxy: ScrollViewProxy) {
        gapRepair?.cancel()
        guard hasPhantomGap else { return }
        gapRepair = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard !Task.isCancelled, hasPhantomGap else { return }
            proxy.scrollTo("bottom", anchor: .bottom)
            // One scrollTo can lose to an in-flight inset animation (keyboard) —
            // confirm the pin took, repair once more if the gap survived.
            try? await Task.sleep(nanoseconds: 200_000_000)
            guard !Task.isCancelled, hasPhantomGap else { return }
            proxy.scrollTo("bottom", anchor: .bottom)
        }
    }

    /// Only messages that actually paint pixels. Hidden kinds (thinking, system,
    /// stream bookkeeping…) used to render as EMPTY rows — and LazyVStack still
    /// inserts its 18pt spacing around each one, so a run of 30 tool-internal
    /// messages produced a ~500pt phantom gap (the "big space" in heavy
    /// tool-driven conversations). Filtering here removes the empty rows entirely.
    private var visibleMessages: [ChatMessage] {
        // isBlank early-exits at the first non-whitespace character and allocates
        // nothing — trimmingCharacters COPIED each message's whole content, which
        // made this filter O(total transcript bytes) per render (typing crawled
        // in conversations holding megabyte tool outputs).
        func isBlank(_ s: String) -> Bool { s.allSatisfy(\.isWhitespace) }
        return relay.messages.filter { m in
            switch m.kind {
            case "text":
                return !isBlank(m.bodyText) || (m.images?.isEmpty == false)
            case "tool_use", "error":
                return true
            case "tool_result":
                return !isBlank(m.content ?? "")
            default:
                return false
            }
        }
    }

    /// Id of the newest assistant text message — the only one that gets a visible
    /// action row (the apps keep older messages clean; long-press still copies).
    private var lastAssistantTextId: String? {
        relay.messages.last(where: { $0.kind == "text" && $0.role != "user" })?.id
    }

    /// What the agent is doing right now, from the newest transcript frame.
    /// A specific backend status ("Waiting for permission") wins over it.
    private var turnActivity: String {
        if let s = relay.statusText, !s.isEmpty, s != "Processing", s != "Working..." { return s }
        for m in relay.messages.reversed() {
            switch m.kind {
            case "tool_use":
                return Self.activityLabel(for: m.toolName)
            case "tool_result", "error":
                return "Working"     // last tool finished — deciding the next step
            case "text":
                return m.role == "user" ? "Working" : "Writing"
            default:
                continue
            }
        }
        return "Working"
    }

    /// Human activity label for a tool in use (mirrors the web client's map).
    static func activityLabel(for tool: String?) -> String {
        switch tool ?? "" {
        case "Bash": return "Running a command"
        case "Read": return "Reading files"
        case "Edit", "Write", "ApplyPatch", "MultiEdit", "NotebookEdit": return "Editing files"
        case "Grep", "Glob": return "Searching the code"
        case "WebFetch", "WebSearch": return "Browsing the web"
        case "Task", "Agent": return "Running a subagent"
        case "TodoWrite": return "Planning"
        case "SendUserFile": return "Sending a file"
        case "AskUserQuestion": return "Asking a question"
        case "": return "Working"
        case let t: return "Using \(t)"
        }
    }

    /// Pin the viewport to the bottom across the frames a LazyVStack needs to
    /// resolve real row heights (a single scroll lands mid-list or past the end).
    private func settleToBottom(_ proxy: ScrollViewProxy) {
        proxy.scrollTo("bottom", anchor: .bottom)
        for delay in [0.05, 0.2, 0.5, 1.0] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                if followMode { proxy.scrollTo("bottom", anchor: .bottom) }
            }
        }
    }


    private func permissionBanner(_ p: ChatMessage) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "hand.raised.fill").foregroundColor(Theme.primary)
                Text("Permission: \(p.toolName ?? "tool")").font(.subheadline).fontWeight(.semibold).foregroundColor(Theme.text)
            }
            HStack {
                Button("Deny") {
                    if let id = p.requestId { relay.answerPermission(requestId: id, allow: false) }
                }
                .buttonStyle(.bordered)
                .tint(Theme.mutedText)
                Button("Allow") {
                    if let id = p.requestId { relay.answerPermission(requestId: id, allow: true) }
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.primary)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface)
        .overlay(Rectangle().frame(height: 1).foregroundColor(Theme.border), alignment: .top)
    }

    /// "412" / "4.2k" / "112k" — tokens generated this turn, CLI-style.
    static func tokensLabel(_ n: Int) -> String {
        if n < 1000 { return "\(n)" }
        if n < 100_000 { return String(format: "%.1fk", Double(n) / 1000) }
        return "\(n / 1000)k"
    }

    /// "42s" / "4m 12s" / "1h 04m" — how long the agent has been working.
    static func elapsedLabel(from start: Date, to now: Date) -> String {
        let s = max(0, Int(now.timeIntervalSince(start)))
        if s < 60 { return "\(s)s" }
        if s < 3600 { return "\(s / 60)m \(String(format: "%02d", s % 60))s" }
        return "\(s / 3600)h \(String(format: "%02d", (s % 3600) / 60))m"
    }

    private func start() async {
        if let previewMessages {
            relay.setHistory(previewMessages)
            relay.isLoading = true
            loadingHistory = false
            #if DEBUG
            // Simulate a turn COMPLETING: drop the loader + shrink the transcript
            // (like the end-of-turn history reconcile) to prove no gap opens below.
            if ProcessInfo.processInfo.environment["MYMU_DEMO_SHRINK"] == "1" {
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
                    relay.isLoading = false
                    relay.setHistory(Array(previewMessages.prefix(max(1, previewMessages.count - 5))))
                }
            }
            #endif
            return
        }
        // Use the relay's CURRENT id — a new conversation starts with "" and gets
        // rebound by session_created; tab-return re-runs then fetch the real id.
        let sid = relay.sessionId
        if !sid.isEmpty {
            do {
                let h = try await APIClient(token: chatToken, origin: origin).history(sessionId: sid)
                relay.setHistory(h.messages)
                if let ctx = h.context { relay.context = ctx }
                // If a stream frame already flipped the loader on, anchor the
                // timer to the real turn start carried by this history fetch.
                relay.applyServerTurnStart(h.turnStartedAt, startContext: h.turnStartContextTokens)
            } catch {
                loadError = error.localizedDescription
            }
        }
        loadingHistory = false
        relay.connect()
    }
}

/// Frame of the whole transcript block in the scroll view's own coordinate
/// space — height drives short-transcript alignment, maxY (the content's bottom
/// edge, directly comparable to the viewport height) drives the gap guard.
private struct ContentFrameKey: PreferenceKey {
    static var defaultValue: CGRect = .zero
    static func reduce(value: inout CGRect, nextValue: () -> CGRect) { value = nextValue() }
}

/// The message composer, isolated so DRAFT-TEXT keystrokes re-render only this
/// small view — never the transcript above it (whole-chat re-render per
/// keystroke made typing crawl in conversations with large histories).
private struct ChatComposer: View {
    @ObservedObject var relay: RelayClient
    /// The agent is pinned to this host but the app has no saved login for it —
    /// arbitrary/binary files can't reach the agent (only image/PDF/text embed
    /// through the relay). Attaching an unsupported type warns instead of
    /// silently dropping it server-side.
    let pinnedHostNeedingLogin: String?
    /// Parent hook fired right before a send (re-arms follow-mode).
    let onWillSend: () -> Void

    @State private var input = ""
    @State private var attachments: [PendingAttachment] = []
    @State private var photoItem: PhotosPickerItem?
    @State private var showFileImporter = false
    @State private var attachError: String?
    @State private var photoPickerPresented = false
    // iPad: a SwiftUI Menu is a popover, and toggling .fileImporter/.photosPicker
    // from inside a Menu item is swallowed as the popover dismisses — the picker
    // never presents (App Store 2.1(a) reject, iPadOS 26). A confirmationDialog
    // finishes dismissing BEFORE its action fires, so the picker presents on iPad
    // and iPhone alike.
    @State private var showAttachDialog = false

    var body: some View {
        VStack(spacing: 0) {
            Rectangle().fill(Theme.border).frame(height: 0.5)
            if !attachments.isEmpty { attachmentChips }
            if let attachError {
                Text(attachError).font(.caption2).foregroundColor(Theme.danger)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16).padding(.top, 6)
            }
            HStack(alignment: .bottom, spacing: 0) {
                Button { showAttachDialog = true } label: {
                    Image(systemName: "plus.circle.fill")
                        .font(.system(size: 26))
                        .foregroundColor(Theme.mutedText)
                }
                .accessibilityIdentifier("composer-attach")
                .accessibilityLabel("Add attachment")
                .padding(.leading, 10)
                .padding(.bottom, 12)

                TextField("", text: $input,
                          prompt: Text("Message MyMu…").foregroundColor(Theme.mutedText),
                          axis: .vertical)
                    .accessibilityIdentifier("composer-input")
                    .lineLimit(1...6)
                    .font(.system(size: 17))
                    .foregroundColor(Theme.text)
                    .tint(Theme.primary)
                    .padding(.leading, 10)
                    .padding(.trailing, 6)
                    .padding(.vertical, 14)

                // Mid-turn sends are allowed for remote agents — the relay queues
                // them into the agent's own message queue (same as the web app), so
                // typed text always SENDS; stop is offered only when the composer
                // is empty. Local sessions keep stop-while-working (no queue there).
                Button {
                    if canSend && (!relay.isLoading || relay.supportsMidTurnSend) {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        onWillSend()
                        let text = input
                        let files = attachments.map { ["name": $0.name, "data": $0.dataURL] }
                        input = ""
                        attachments = []
                        relay.send(text, attachments: files)
                    } else if relay.isLoading {
                        relay.abort()
                    }
                } label: {
                    Image(systemName: (canSend && (!relay.isLoading || relay.supportsMidTurnSend))
                          ? "arrow.up.circle.fill"
                          : (relay.isLoading ? "stop.circle.fill" : "arrow.up.circle.fill"))
                        .font(.system(size: 32))
                        .foregroundColor(sendButtonActive ? Theme.primary : Theme.mutedText.opacity(0.5))
                }
                .accessibilityIdentifier("composer-send")
                .disabled(!relay.isLoading && !canSend)
                .padding(.trailing, 6)
                .padding(.bottom, 7)
            }
            .frame(minHeight: 52)
            .background(Theme.surface)
            .clipShape(RoundedRectangle(cornerRadius: 26))
            .overlay(RoundedRectangle(cornerRadius: 26).stroke(Theme.border, lineWidth: 1))
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
        }
        .background(Theme.background)
        .confirmationDialog("Add attachment", isPresented: $showAttachDialog, titleVisibility: .visible) {
            Button("Photo library") { photoPickerPresented = true }
            Button("Attach file") { showFileImporter = true }
            Button("Cancel", role: .cancel) { }
        }
        .photosPicker(isPresented: $photoPickerPresented, selection: $photoItem, matching: .images)
        .fileImporter(isPresented: $showFileImporter,
                      allowedContentTypes: [UTType.item],
                      allowsMultipleSelection: false) { result in
            if case .success(let urls) = result, let url = urls.first { addFileAttachment(url) }
        }
        .onChange(of: photoItem) { item in
            guard let item else { return }
            photoItem = nil
            Task { await addPhotoAttachment(item) }
        }
    }

    private var attachmentChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(attachments) { a in
                    HStack(spacing: 6) {
                        Image(systemName: a.isImage ? "photo" : "doc")
                            .font(.caption2).foregroundColor(Theme.primary)
                        Text(a.name).font(.caption).foregroundColor(Theme.text).lineLimit(1)
                        Button {
                            attachments.removeAll { $0.id == a.id }
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.caption).foregroundColor(Theme.mutedText)
                        }
                    }
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .background(Theme.surface)
                    .clipShape(Capsule())
                    .overlay(Capsule().stroke(Theme.border, lineWidth: 1))
                }
            }
            .padding(.horizontal, 16).padding(.top, 8)
        }
    }

    private var canSend: Bool {
        !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty
    }

    // MARK: attachment ingestion

    private static let maxAttachmentBytes = 10 * 1024 * 1024

    private func addPhotoAttachment(_ item: PhotosPickerItem) async {
        attachError = nil
        guard let data = try? await item.loadTransferable(type: Data.self),
              let img = UIImage(data: data),
              let jpeg = img.jpegData(compressionQuality: 0.85) else {
            attachError = "Couldn’t load that photo."
            return
        }
        guard jpeg.count <= Self.maxAttachmentBytes else {
            attachError = "Photo is too large (max 10 MB)."
            return
        }
        attachments.append(PendingAttachment(
            name: "photo-\(attachments.count + 1).jpg",
            dataURL: "data:image/jpeg;base64,\(jpeg.base64EncodedString())",
            isImage: true))
    }

    /// Types the relay can EMBED as content blocks (server toUserContent):
    /// image/PDF/text reach any agent; everything else needs the file to LAND on
    /// the agent's host — impossible without a login there.
    private static let embeddableTextExts: Set<String> = [
        "txt", "md", "markdown", "json", "csv", "tsv", "xml", "yaml", "yml", "toml", "ini", "cfg",
        "conf", "env", "log", "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "java",
        "c", "cpp", "cc", "h", "hpp", "cs", "php", "sh", "bash", "zsh", "sql", "html", "htm", "css",
        "scss", "less", "vue", "svelte", "svg", "dockerfile", "gitignore", "lua", "r", "kt", "swift",
    ]
    private static func embedsWithoutLanding(mime: String, name: String) -> Bool {
        if mime.hasPrefix("image/") || mime.hasPrefix("text/") || mime == "application/pdf" { return true }
        return embeddableTextExts.contains((name as NSString).pathExtension.lowercased())
    }

    private func addFileAttachment(_ url: URL) {
        attachError = nil
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else {
            attachError = "Couldn’t read that file."
            return
        }
        guard data.count <= Self.maxAttachmentBytes else {
            attachError = "File is too large (max 10 MB)."
            return
        }
        let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        // Agent pinned to a host we're not logged into: this file type can't
        // reach it (would be dropped server-side with a placeholder note).
        if let host = pinnedHostNeedingLogin,
           !Self.embedsWithoutLanding(mime: mime, name: url.lastPathComponent) {
            attachError = "Can’t share this file: the agent runs on \(host), which you’re not signed in to. Add that account (profile → Add account) to send files."
            return
        }
        attachments.append(PendingAttachment(
            name: url.lastPathComponent,
            dataURL: "data:\(mime);base64,\(data.base64EncodedString())",
            isImage: mime.hasPrefix("image/")))
    }

    private var sendButtonActive: Bool { relay.isLoading || canSend }
}


/// Consumed context tokens for the open conversation, as a raw count ("265k").
/// A percentage needs a correctly configured window size to be truthful — the
/// raw number is always right. Updated on open and at each turn end.
struct ContextMeter: View {
    let usage: ContextUsage

    private var label: String {
        let n = usage.usedTokens
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000 { return "\(Int((Double(n) / 1_000).rounded()))k" }
        return "\(n)"
    }

    var body: some View {
        // Subtitle under the agent name: plain text, no capsule. The pill
        // chrome existed to separate it from the toolbar buttons it used to sit
        // beside; under the title it would just crowd the nav bar.
        Text("\(label) tokens")
            .font(.system(size: 11, weight: .regular, design: .monospaced))
            .foregroundColor(Theme.mutedText)
            .lineLimit(1)
            .accessibilityLabel("\(usage.usedTokens) context tokens used")
    }
}
