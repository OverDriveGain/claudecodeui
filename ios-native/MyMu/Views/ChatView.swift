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
    // shrinks after we pinned the bottom: end-of-turn history reconcile, media
    // rows resizing, keyboard dismissal). We watch where the bottom sentinel
    // actually sits; if it rests well above the fold for ~½s, re-pin.
    @State private var sentinelBottom: CGFloat = .greatestFiniteMagnitude
    @State private var viewportHeight: CGFloat = 0
    @State private var contentHeight: CGFloat = 0
    @State private var gapRepair: Task<Void, Never>?
    private let previewMessages: [ChatMessage]?

    init(sessionId: String, projectId: String, isRemote: Bool, title: String, token: String,
         projectPath: String? = nil, previewMessages: [ChatMessage]? = nil) {
        self.sessionId = sessionId
        self.projectId = projectId
        self.isRemote = isRemote
        self.title = title
        self.previewMessages = previewMessages
        _relay = StateObject(wrappedValue: RelayClient(token: token, sessionId: sessionId,
                                                       isRemote: isRemote, projectPath: projectPath))
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
                ChatComposer(relay: relay, onWillSend: { followMode = true })
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.background, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                HStack(spacing: 12) {
                    if let ctx = relay.context {
                        ContextMeter(usage: ctx)
                    }
                    NavigationLink {
                        FilesView(projectId: projectId, token: appState.token ?? "", title: title)
                    } label: {
                        Image(systemName: "folder").foregroundColor(Theme.primary)
                    }
                }
            }
        }
        .task { await start() }
        .onDisappear { relay.disconnect() }
    }

    private var messagesList: some View {
        GeometryReader { outer in
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if loadingHistory {
                        MyMuLoader().frame(maxWidth: .infinity).padding(.top, 24)
                    }
                    if let loadError {
                        Text(loadError).font(.footnote).foregroundColor(Theme.danger)
                    }
                    ForEach(visibleMessages) { m in
                        MessageRow(message: m, projectId: projectId, token: appState.token ?? "",
                                   showActions: m.id == lastAssistantTextId)
                            .equatable()
                            .id(m.id)
                    }
                    // Inline thinking indicator — last transcript row, centered like
                    // the web app's ClaudeStatus (justify-center).
                    if relay.isLoading && !loadingHistory {
                        MyMuLoader()
                            .frame(maxWidth: .infinity)
                            .padding(.top, 2)
                    }
                    // Bottom sentinel: visible ⇒ the viewport is at the bottom. Drives
                    // the ↓ pill, re-arms follow-mode, and feeds the gap guard.
                    Color.clear.frame(height: 1).id("bottom")
                        .background(GeometryReader { g in
                            Color.clear.preference(key: SentinelBottomKey.self,
                                                   value: g.frame(in: .named("chatScroll")).maxY)
                        })
                        .onAppear { atBottom = true; followMode = true }
                        .onDisappear {
                            atBottom = false
                            // Offscreen sentinel ⇒ no visible gap; a stale small value
                            // must never yank a user who scrolled up to read.
                            sentinelBottom = .greatestFiniteMagnitude
                            gapRepair?.cancel()
                        }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                // Anchor the transcript to the BOTTOM: force the content to be at
                // least as tall as the viewport and bottom-align it (the iMessage/
                // ChatGPT layout). When the transcript is shorter than the screen —
                // or SHRINKS after we pinned the bottom (loader row removed at turn
                // end, history reconcile swapping in a shorter transcript, keyboard
                // dismissal) — the last message stays glued to the composer instead
                // of leaving a blank strip above it. Taller-than-screen transcripts
                // exceed minHeight, so normal scrolling + follow-mode take over.
                .frame(maxWidth: .infinity, minHeight: viewportHeight, alignment: .bottomLeading)
                .background(GeometryReader { g in
                    Color.clear.preference(key: ContentHeightKey.self, value: g.size.height)
                })
            }
            .coordinateSpace(name: "chatScroll")
            .onAppear { viewportHeight = outer.size.height }
            .onChange(of: outer.size.height) { h in
                let delta = h - viewportHeight
                viewportHeight = h
                // Only keyboard-scale changes (composer line-wraps are ~20pt and
                // settling on those made typing trigger scroll storms).
                guard followMode, abs(delta) > 60 else { return }
                if delta < 0 {
                    // Keyboard OPENING: ride the system animation with ONE
                    // animated pin — repeated instant snaps mid-animation yanked
                    // the transcript up "in a flaky way". A silent correction
                    // after the animation settles catches any drift.
                    withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo("bottom", anchor: .bottom) }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
                        if followMode { proxy.scrollTo("bottom", anchor: .bottom) }
                    }
                } else {
                    // Keyboard DISMISSING (viewport grows): a single scrollTo
                    // loses the race against the inset animation and the view
                    // settles over-scrolled (blank strip below the last message,
                    // "have to scroll up") — re-pin across the animation frames.
                    settleToBottom(proxy)
                }
            }
            .onPreferenceChange(ContentHeightKey.self) { contentHeight = $0 }
            .onPreferenceChange(SentinelBottomKey.self) { v in
                sentinelBottom = v
                scheduleGapRepair(proxy)
            }
            .scrollDismissesKeyboard(.interactively)
            // An explicit upward drag is the ONE gesture that means "stop following".
            .simultaneousGesture(
                DragGesture().onChanged { v in
                    if v.translation.height > 12 { followMode = false }
                }
            )
            // Follow every content mutation (stream chunks included) WITHOUT animation:
            // animated jumps over a LazyVStack overshoot into estimated space — that
            // was the "big empty gap below the last message".
            .onChange(of: relay.revision) { _ in
                if followMode { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            // Initial jump after history load: lazy row heights settle over several
            // frames, so re-pin the bottom a few times, non-animated.
            .onChange(of: loadingHistory) { loading in
                if !loading { settleToBottom(proxy) }
            }
            .overlay(alignment: .bottomTrailing) {
                if !atBottom {
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
    /// while there is enough content to fill the screen — a phantom blank strip.
    private var hasPhantomGap: Bool {
        viewportHeight > 0
            && contentHeight > viewportHeight + 1
            && sentinelBottom < viewportHeight - 48
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
                return !isBlank(m.bodyText)
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
                let h = try await appState.api.history(sessionId: sid)
                relay.setHistory(h.messages)
                if let ctx = h.context { relay.context = ctx }
            } catch {
                loadError = error.localizedDescription
            }
        }
        loadingHistory = false
        relay.connect()
    }
}

/// Bottom edge of the transcript's last row, in the scroll view's own
/// coordinate space (so it's directly comparable to the viewport height).
private struct SentinelBottomKey: PreferenceKey {
    static var defaultValue: CGFloat = .greatestFiniteMagnitude
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

private struct ContentHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

/// The message composer, isolated so DRAFT-TEXT keystrokes re-render only this
/// small view — never the transcript above it (whole-chat re-render per
/// keystroke made typing crawl in conversations with large histories).
private struct ChatComposer: View {
    @ObservedObject var relay: RelayClient
    /// Parent hook fired right before a send (re-arms follow-mode).
    let onWillSend: () -> Void

    @State private var input = ""
    @State private var attachments: [PendingAttachment] = []
    @State private var photoItem: PhotosPickerItem?
    @State private var showFileImporter = false
    @State private var attachError: String?
    @State private var photoPickerPresented = false

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
                Menu {
                    Button { showFileImporter = true } label: { Label("Attach file", systemImage: "doc") }
                    // PhotosPicker presented via the modifier below.
                    Button { photoPickerPresented = true } label: { Label("Photo library", systemImage: "photo") }
                } label: {
                    Image(systemName: "plus.circle.fill")
                        .font(.system(size: 26))
                        .foregroundColor(Theme.mutedText)
                }
                .padding(.leading, 10)
                .padding(.bottom, 12)

                TextField("", text: $input,
                          prompt: Text("Message MyMu…").foregroundColor(Theme.mutedText),
                          axis: .vertical)
                    .lineLimit(1...6)
                    .font(.system(size: 17))
                    .foregroundColor(Theme.text)
                    .tint(Theme.primary)
                    .padding(.leading, 10)
                    .padding(.trailing, 6)
                    .padding(.vertical, 14)

                Button {
                    if relay.isLoading {
                        relay.abort()
                    } else {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        onWillSend()
                        let text = input
                        let files = attachments.map { ["name": $0.name, "data": $0.dataURL] }
                        input = ""
                        attachments = []
                        relay.send(text, attachments: files)
                    }
                } label: {
                    Image(systemName: relay.isLoading ? "stop.circle.fill" : "arrow.up.circle.fill")
                        .font(.system(size: 32))
                        .foregroundColor(sendButtonActive ? Theme.primary : Theme.mutedText.opacity(0.5))
                }
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
        attachments.append(PendingAttachment(
            name: url.lastPathComponent,
            dataURL: "data:\(mime);base64,\(data.base64EncodedString())",
            isImage: mime.hasPrefix("image/")))
    }

    private var sendButtonActive: Bool { relay.isLoading || canSend }
}


/// Tiny ring showing how full the agent's context window is (green → amber →
/// red as it fills). Updated from history fetches: on open and at each turn end.
struct ContextMeter: View {
    let usage: ContextUsage

    private var color: Color {
        switch usage.fraction {
        case ..<0.6: return Color(hex: "6BBF6B")
        case ..<0.85: return .orange
        default: return Theme.danger
        }
    }

    var body: some View {
        ZStack {
            Circle().stroke(Theme.border, lineWidth: 3)
            Circle()
                .trim(from: 0, to: usage.fraction)
                .stroke(color, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Text("\(Int(usage.fraction * 100))")
                .font(.system(size: 8, weight: .semibold))
                .foregroundColor(Theme.mutedText)
        }
        .frame(width: 24, height: 24)
        .accessibilityLabel("Context \(Int(usage.fraction * 100)) percent full")
    }
}
