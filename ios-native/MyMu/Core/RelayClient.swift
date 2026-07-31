import Foundation

/// Live chat over the web app's `/ws` socket. Subscribes to a remote agent
/// session, streams normalized frames into `messages`, and sends prompts /
/// permission answers / aborts using the exact protocol the web client speaks.
///
/// The server does all relay + normalization; this client renders the
/// `kind`-tagged frames (see server/shared/types.ts NormalizedMessage) and keeps
/// itself honest with (a) auto-reconnect + re-subscribe on drops and (b) a REST
/// history reconcile at the end of every turn, which dedupes streamed vs final
/// text and fixes ordering — the two things that made the chat feel flaky.
@MainActor
final class RelayClient: ObservableObject {
    @Published var messages: [ChatMessage] = []
    @Published var isLoading = false {
        didSet {
            // Date() is only a provisional anchor — the real turn start (the user
            // prompt's transcript timestamp) replaces it via applyServerTurnStart,
            // so reopening a mid-turn conversation shows true elapsed, not zero.
            if isLoading && !oldValue {
                turnStartedAt = Date(); turnAnchored = false
                // Baseline for the token counter: the last known context position.
                turnStartContext = context?.usedTokens
                turnTokens = nil
            }
            if !isLoading { turnStartedAt = nil; turnAnchored = false; turnStartContext = nil; turnTokens = nil }
        }
    }
    /// When the current turn started — drives the elapsed timer on the loader.
    @Published var turnStartedAt: Date?
    /// Tokens the context grew since the turn started ("tokens this turn"),
    /// ticking live off assistant frames' absolute contextTokens field.
    @Published var turnTokens: Int?
    private var turnStartContext: Int?
    /// True once turnStartedAt holds the REAL turn start (local send or server
    /// transcript timestamp) rather than the provisional "when I noticed" stamp.
    private var turnAnchored = false
    /// Armed by send(); the first response frame fires the reply haptic.
    private var awaitingFirstResponse = false

    private func noteResponseActivity() {
        if awaitingFirstResponse { awaitingFirstResponse = false; Haptics.firstResponse() }
    }
    @Published var statusText: String?
    @Published var connected = false
    @Published var pendingPermission: ChatMessage?
    /// Bumped on EVERY content mutation (new message, stream chunk, history swap).
    /// The view follows this — messages.count misses stream growth inside one message.
    @Published var revision = 0
    /// Context-window fullness from the last history fetch (nil until known).
    @Published var context: ContextUsage?

    private let token: String
    private(set) var sessionId: String
    private let projectPath: String?
    private var task: URLSessionWebSocketTask?
    private var keepAlive: Task<Void, Never>?
    private var streamingId: String?
    private var seq = 0
    private var reconnectAttempts = 0
    private var intentionalClose = false
    /// Highest `seq` seen from the server — chat.subscribe replays everything
    /// after this, closing gaps from drops/backgrounding.
    private var lastSeq = 0

    init(token: String, sessionId: String, projectPath: String? = nil) {
        self.token = token
        self.sessionId = sessionId
        self.projectPath = projectPath
    }

    // MARK: Lifecycle

    func connect() {
        intentionalClose = false
        openSocket()
    }

    private func openSocket() {
        guard task == nil else { return }
        let ws = URLSession.shared.webSocketTask(with: Config.webSocketURL(token: token))
        task = ws
        ws.resume()
        connected = true
        receiveLoop()
        subscribe()
        keepAlive?.cancel()
        keepAlive = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 45 * 1_000_000_000)
                self?.subscribe()
            }
        }
    }

    func disconnect() {
        intentionalClose = true
        keepAlive?.cancel(); keepAlive = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        connected = false
    }

    private func subscribe() {
        // A brand-new conversation has no id to attach yet — the first send
        // allocates one and subscribes.
        guard !sessionId.isEmpty else { return }
        sendJSON(["type": "chat.subscribe", "sessions": [["sessionId": sessionId, "lastSeq": lastSeq]]])
    }

    /// Foreground kick: iOS kills sockets in the background but they look alive
    /// until the next I/O fails, so returning to the app could sit stale for the
    /// full backoff. Re-subscribe (or reopen) and reconcile immediately instead.
    func ensureConnected() {
        if task == nil { openSocket() } else { subscribe() }
        reconcile()
    }

    private func scheduleReconnect() {
        guard !intentionalClose else { return }
        task = nil
        reconnectAttempts += 1
        // Fast first retries (0.5s, 1s, 2s…) — the old 2s/4s/…/15s curve left
        // visible dead air after every network blip.
        let delay = min(0.5 * pow(2.0, Double(reconnectAttempts - 1)), 8.0)
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard let self, !self.intentionalClose else { return }
            self.openSocket()
            self.reconcile()   // catch up on anything missed while disconnected
        }
    }

    // MARK: Outbound

    /// Send a prompt, optionally with attachments in the web client's
    /// `options.images` shape: `[{name, data: "data:<mime>;base64,…"}]` — the
    /// server converts them to image/PDF/text content blocks (toUserContent).
    func send(_ text: String, attachments: [[String: String]] = []) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !attachments.isEmpty else { return }
        // Images render inline in the bubble; only non-image files fall back to a
        // "📎 name" chip line.
        let imageURLs = attachments.compactMap { $0["data"] }.filter { $0.hasPrefix("data:image/") }
        let otherFiles = attachments.filter { !($0["data"]?.hasPrefix("data:image/") ?? false) }
        var shown = trimmed
        if !otherFiles.isEmpty {
            let names = otherFiles.compactMap { $0["name"] }.map { "📎 \($0)" }.joined(separator: "\n")
            shown = shown.isEmpty ? names : shown + "\n" + names
        }
        var localMsg = ChatMessage(id: "local-\(nextSeq())", kind: "text", role: "user", content: shown)
        if !imageURLs.isEmpty { localMsg.images = imageURLs }
        appendOrReplace(localMsg)
        isLoading = true
        // A turn started HERE is anchored exactly by the send moment; a mid-turn
        // queued message must NOT restart the timer (isLoading was already true).
        turnAnchored = true
        awaitingFirstResponse = true
        // iOS kills sockets in the background; a send into a dead one would
        // silently vanish behind the optimistic bubble. Reopen before sending.
        if task == nil { openSocket() }
        Task { [weak self] in
            guard let self else { return }
            // 1. Sessions exist BEFORE the first message (allocated over REST —
            //    the standard claudecodeui contract).
            if self.sessionId.isEmpty {
                guard let projectPath = self.projectPath,
                      let newId = try? await APIClient(token: self.token)
                          .createProviderSession(projectPath: projectPath) else {
                    self.appendOrReplace(ChatMessage(id: "err-\(self.nextSeq())", kind: "error", role: "assistant",
                                                     content: "Could not create a session on this server.", isError: true))
                    self.isLoading = false
                    return
                }
                self.sessionId = newId
                self.subscribe()   // attach the live stream so replay covers the whole run
            }
            // 2. Attachments go to the server's asset store first and are
            //    referenced by path (standard flow); a failed upload keeps the
            //    text going and reports the loss instead of vanishing silently.
            var options: [String: Any] = [:]
            if !attachments.isEmpty {
                do {
                    let records = try await self.uploadAttachments(attachments)
                    if !records.isEmpty { options["images"] = records }
                } catch {
                    self.appendOrReplace(ChatMessage(id: "err-\(self.nextSeq())", kind: "error", role: "assistant",
                                                     content: "Attachment upload failed — sending without files. (\(error.localizedDescription))",
                                                     isError: true))
                }
            }
            self.sendJSON(["type": "chat.send", "sessionId": self.sessionId, "content": trimmed, "options": options], retryOnce: true)
        }
    }

    /// Uploads composer attachments (held as data-URLs) to the asset store and
    /// returns the `{name, path, mimeType}` records chat.send references.
    /// Images and other files go to their respective store routes.
    private func uploadAttachments(_ attachments: [[String: String]]) async throws -> [[String: Any]] {
        var images: [(name: String, mime: String, bytes: Data)] = []
        var files: [(name: String, mime: String, bytes: Data)] = []
        for attachment in attachments {
            guard let dataURL = attachment["data"], let parsed = Self.parseDataURL(dataURL) else { continue }
            let entry = (name: attachment["name"] ?? "attachment", mime: parsed.mime, bytes: parsed.bytes)
            if parsed.mime.hasPrefix("image/") { images.append(entry) } else { files.append(entry) }
        }
        let api = APIClient(token: token)
        var records: [APIClient.AssetRecord] = []
        if !images.isEmpty { records += try await api.uploadAssets(images, field: "images") }
        if !files.isEmpty { records += try await api.uploadAssets(files, field: "files") }
        return records.map { record in
            var entry: [String: Any] = ["path": record.path]
            if let name = record.name { entry["name"] = name }
            if let mimeType = record.mimeType { entry["mimeType"] = mimeType }
            return entry
        }
    }

    /// "data:<mime>;base64,<payload>" → (mime, bytes). Returns nil for
    /// malformed or non-base64 data URLs.
    static func parseDataURL(_ dataURL: String) -> (mime: String, bytes: Data)? {
        guard dataURL.hasPrefix("data:"), let comma = dataURL.firstIndex(of: ",") else { return nil }
        let header = String(dataURL[dataURL.index(dataURL.startIndex, offsetBy: 5)..<comma])
        let mime = header.split(separator: ";").first.map(String.init) ?? ""
        guard let bytes = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...])) else { return nil }
        return (mime.isEmpty ? "application/octet-stream" : mime, bytes)
    }

    func answerPermission(requestId: String, allow: Bool) {
        sendJSON(["type": "chat.permission-response", "requestId": requestId, "allow": allow])
        pendingPermission = nil
    }

    func abort() {
        sendJSON(["type": "chat.abort", "sessionId": sessionId])
        isLoading = false
    }

    /// Anchor the elapsed timer to the transcript's turn-start timestamp and
    /// seed the token counter's baseline when the server provides one.
    /// Ignored when idle (a stale anchor from a finished turn must not revive).
    func applyServerTurnStart(_ iso: String?, startContext: Int? = nil) {
        guard isLoading, let iso, let date = Self.parseISO(iso) else { return }
        turnStartedAt = date
        turnAnchored = true
        if let startContext {
            turnStartContext = startContext
            if let current = context?.usedTokens {
                turnTokens = max(0, current - startContext)
            }
        }
    }

    /// Assistant frames carry the absolute context position; diff against the
    /// turn baseline for the live counter. Absolute values are replay-safe —
    /// duplicated frames can never double-count.
    private func noteContextTokens(_ tokens: Int) {
        guard isLoading else { return }
        if turnStartContext == nil { turnStartContext = tokens }
        turnTokens = max(0, tokens - (turnStartContext ?? tokens))
        // Keep the header context meter live during the turn too.
        if let c = context, tokens > c.usedTokens {
            context = ContextUsage(usedTokens: tokens, windowTokens: c.windowTokens)
        }
    }

    /// Relay timestamps carry microsecond fractions ("…T00:03:53.981039Z") that
    /// ISO8601DateFormatter rejects — drop the fraction (second precision is
    /// plenty for an elapsed timer).
    static func parseISO(_ s: String) -> Date? {
        let cleaned = s.replacingOccurrences(of: #"\.\d+"#, with: "", options: .regularExpression)
        return ISO8601DateFormatter().date(from: cleaned)
    }

    // MARK: History

    func setHistory(_ history: [ChatMessage]) {
        messages = history
        revision += 1
    }

    /// Re-fetch the authoritative transcript and replace the live list. Only when
    /// idle, so an in-progress streaming turn is never wiped mid-flight.
    private func reconcile() {
        guard !isLoading else { return }
        Task { [weak self] in
            guard let self else { return }
            if let h = try? await APIClient(token: self.token).history(sessionId: self.sessionId) {
                if !self.isLoading { self.setHistory(h.messages) }
                if let ctx = h.context { self.context = ctx }
            }
        }
    }

    private func scheduleReconcile() {
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 700_000_000)
            self?.reconcile()
        }
    }

    // MARK: Inbound

    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self else { return }
            Task { @MainActor in
                switch result {
                case .failure:
                    self.connected = false
                    self.scheduleReconnect()
                case .success(let message):
                    self.reconnectAttempts = 0
                    if case let .string(text) = message { self.handle(text) }
                    self.receiveLoop()
                }
            }
        }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }

        let type = obj["type"] as? String
        let kind = obj["kind"] as? String

        // Any non-delta frame must observe the fully-applied stream so ordering
        // holds (e.g. stream_end / tool_use arriving between coalesced flushes).
        if kind != "stream_delta" {
            chunkFlushTask?.cancel()
            chunkFlushTask = nil
            flushStreamChunk()
        }

        if type == "session-status" {
            if let processing = obj["isProcessing"] as? Bool { isLoading = processing }
            if let status = obj["status"] as? [String: Any], let t = status["text"] as? String { statusText = t }
            return
        }

        // Live token counter: assistant frames carry the absolute context position.
        if let ctx = obj["contextTokens"] as? Int { noteContextTokens(ctx) }

        // Upstream frames carry a per-run seq — remember the high-water mark so
        // the next chat.subscribe replays only what we actually missed.
        if let s = obj["seq"] as? Int { lastSeq = max(lastSeq, s) }

        switch kind {
        case "chat_subscribed":
            // Upstream's subscribe ack: authoritative running/pending snapshot.
            if let processing = obj["isProcessing"] as? Bool {
                if processing { isLoading = true }
                // A just-sent turn can't have finished before its first frame —
                // don't let a pre-run snapshot kill the fresh loader.
                else if !awaitingFirstResponse { isLoading = false }
            }
            if let pending = obj["pendingPermissions"] as? [[String: Any]],
               let first = pending.first, let requestId = first["requestId"] as? String {
                var m = ChatMessage(id: (first["id"] as? String) ?? "perm-\(nextSeq())",
                                    kind: "permission_request", role: "assistant",
                                    toolName: first["toolName"] as? String)
                m.requestId = requestId
                pendingPermission = m
            }
            return
        case "session_upserted", "loading_progress":
            return
        case "protocol_error":
            streamingId = nil
            Haptics.error()
            appendOrReplace(ChatMessage(id: messageId(obj), kind: "error", role: "assistant",
                                        content: (obj["message"] as? String) ?? "Server rejected the request.",
                                        isError: true))
            isLoading = false
            return
        default:
            break
        }

        switch kind {
        case "stream_delta":
            noteResponseActivity()
            appendStream(obj["content"] as? String ?? "")
            isLoading = true
        case "stream_end":
            streamingId = nil
        case "text":
            streamingId = nil
            let role = obj["role"] as? String ?? "assistant"
            if role == "assistant" { noteResponseActivity() }
            let body = (obj["displayText"] as? String) ?? (obj["content"] as? String) ?? ""
            if !body.isEmpty {
                // The relay echoes the user's own message back as a text frame. If we
                // already showed it optimistically (id "local-…"), reconcile that bubble
                // to the server id instead of appending a duplicate.
                if role == "user",
                   let idx = messages.firstIndex(where: { m in
                       guard m.id.hasPrefix("local-"), m.role == "user" else { return false }
                       let c = m.content ?? ""
                       // Local bubble may carry "📎 name" lines the echo lacks.
                       return c == body || c.hasPrefix(body + "\n📎") || (body.isEmpty && c.hasPrefix("📎"))
                   }) {
                    messages[idx].id = messageId(obj)
                } else {
                    appendOrReplace(ChatMessage(id: messageId(obj), kind: "text", role: role, content: body))
                }
            }
        case "tool_use":
            noteResponseActivity()
            var m = ChatMessage(id: messageId(obj), kind: "tool_use", role: "assistant",
                                toolName: obj["toolName"] as? String)
            if let ti = obj["toolInput"] { m.toolInput = AnyCodable(ti) }
            appendOrReplace(m)
        case "tool_result":
            appendOrReplace(ChatMessage(id: messageId(obj), kind: "tool_result", role: "assistant",
                                        content: obj["content"] as? String, isError: obj["isError"] as? Bool))
        case "status":
            statusText = obj["text"] as? String
            isLoading = true
        case "permission_request":
            Haptics.attention()
            var m = ChatMessage(id: messageId(obj), kind: "permission_request", role: "assistant",
                                toolName: obj["toolName"] as? String)
            m.requestId = obj["requestId"] as? String
            pendingPermission = m
        case "session_created":
            // A fresh conversation gets its real id at turn start — rebind so
            // resumes and history reads target the actual session. (Vanilla
            // pre-creates the id over REST and never emits this; harmless there.)
            if let newId = (obj["newSessionId"] as? String) ?? (obj["sessionId"] as? String), !newId.isEmpty {
                sessionId = newId
            }
        case "permission_cancelled":
            pendingPermission = nil
        case "error":
            streamingId = nil
            Haptics.error()
            appendOrReplace(ChatMessage(id: messageId(obj), kind: "error", role: "assistant",
                                        content: obj["content"] as? String, isError: true))
            isLoading = false
        case "complete":
            streamingId = nil
            if isLoading { Haptics.complete() }
            isLoading = false
            statusText = nil
            scheduleReconcile()
        default:
            break
        }
    }

    // MARK: helpers

    // Stream chunks arrive per-token; publishing `messages` on each one forced a
    // full SwiftUI re-render per token — long replies made the whole chat crawl
    // (O(n²): every token re-rendered the entire growing message). Coalesce to
    // ~12 UI updates/second; `handle` flushes synchronously before any non-delta
    // frame so ordering is preserved.
    private var pendingChunk = ""
    private var chunkFlushTask: Task<Void, Never>?

    private func appendStream(_ chunk: String) {
        pendingChunk += chunk
        guard chunkFlushTask == nil else { return }
        chunkFlushTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 80_000_000)
            guard let self, !Task.isCancelled else { return }
            self.chunkFlushTask = nil
            self.flushStreamChunk()
        }
    }

    private func flushStreamChunk() {
        guard !pendingChunk.isEmpty else { return }
        let chunk = pendingChunk
        pendingChunk = ""
        if let sid = streamingId, let idx = messages.firstIndex(where: { $0.id == sid }) {
            messages[idx].content = (messages[idx].content ?? "") + chunk
        } else {
            let id = "stream-\(nextSeq())"
            streamingId = id
            messages.append(ChatMessage(id: id, kind: "text", role: "assistant", content: chunk))
        }
        revision += 1
    }

    private func appendOrReplace(_ m: ChatMessage) {
        if let idx = messages.firstIndex(where: { $0.id == m.id }) {
            messages[idx] = m
        } else {
            messages.append(m)
        }
        revision += 1
    }

    private func messageId(_ obj: [String: Any]) -> String {
        (obj["id"] as? String) ?? "srv-\(nextSeq())"
    }

    private func nextSeq() -> Int { seq += 1; return seq }

    private func sendJSON(_ dict: [String: Any], retryOnce: Bool = false) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let str = String(data: data, encoding: .utf8) else { return }
        let ws = task
        ws?.send(.string(str)) { [weak self] error in
            guard error != nil, retryOnce else { return }
            // Dead socket (backgrounding kills them): reopen and resend once so
            // the message the user already sees as sent actually goes out.
            Task { @MainActor in
                guard let self else { return }
                if self.task === ws { self.task = nil }
                self.openSocket()
                try? await Task.sleep(nanoseconds: 700_000_000)
                self.task?.send(.string(str)) { _ in }
            }
        }
    }
}
