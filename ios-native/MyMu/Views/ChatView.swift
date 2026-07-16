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
    @State private var input = ""
    @State private var loadError: String?
    @State private var loadingHistory = true
    @State private var atBottom = true
    // Follow-mode = the user's INTENT to ride the bottom. Only an explicit upward
    // drag turns it off; reaching the bottom (any way), sending, or tapping the
    // pill turns it back on. Deriving intent from sentinel visibility alone made
    // following stop whenever content growth pushed the sentinel away (the old
    // flakiness), so intent and position are tracked separately now.
    @State private var followMode = true
    @State private var attachments: [PendingAttachment] = []
    @State private var photoItem: PhotosPickerItem?
    @State private var showFileImporter = false
    @State private var attachError: String?
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
                inputBar
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.background, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                NavigationLink {
                    FilesView(projectId: projectId, token: appState.token ?? "", title: title)
                } label: {
                    Image(systemName: "folder").foregroundColor(Theme.primary)
                }
            }
        }
        .task { await start() }
        .onDisappear { relay.disconnect() }
    }

    private var messagesList: some View {
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
                    // the ↓ pill and re-arms follow-mode when the user returns down.
                    Color.clear.frame(height: 1).id("bottom")
                        .onAppear { atBottom = true; followMode = true }
                        .onDisappear { atBottom = false }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
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
                        withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo("bottom", anchor: .bottom) }
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

    /// Only messages that actually paint pixels. Hidden kinds (thinking, system,
    /// stream bookkeeping…) used to render as EMPTY rows — and LazyVStack still
    /// inserts its 18pt spacing around each one, so a run of 30 tool-internal
    /// messages produced a ~500pt phantom gap (the "big space" in heavy
    /// tool-driven conversations). Filtering here removes the empty rows entirely.
    private var visibleMessages: [ChatMessage] {
        relay.messages.filter { m in
            switch m.kind {
            case "text":
                return !m.bodyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            case "tool_use", "error":
                return true
            case "tool_result":
                return !(m.content ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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

    private var inputBar: some View {
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
                        followMode = true
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

    @State private var photoPickerPresented = false

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
            return
        }
        // Use the relay's CURRENT id — a new conversation starts with "" and gets
        // rebound by session_created; tab-return re-runs then fetch the real id.
        let sid = relay.sessionId
        if !sid.isEmpty {
            do {
                let h = try await appState.api.history(sessionId: sid)
                relay.setHistory(h.messages)
            } catch {
                loadError = error.localizedDescription
            }
        }
        loadingHistory = false
        relay.connect()
    }
}
