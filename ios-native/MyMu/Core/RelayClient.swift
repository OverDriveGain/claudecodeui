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
    @Published var isLoading = false
    @Published var statusText: String?
    @Published var connected = false
    @Published var pendingPermission: ChatMessage?
    /// Bumped on EVERY content mutation (new message, stream chunk, history swap).
    /// The view follows this — messages.count misses stream growth inside one message.
    @Published var revision = 0

    private let token: String
    private(set) var sessionId: String
    private let isRemote: Bool
    private let projectPath: String?
    private var task: URLSessionWebSocketTask?
    private var keepAlive: Task<Void, Never>?
    private var streamingId: String?
    private var seq = 0
    private var reconnectAttempts = 0
    private var intentionalClose = false

    init(token: String, sessionId: String, isRemote: Bool, projectPath: String? = nil) {
        self.token = token
        self.sessionId = sessionId
        self.isRemote = isRemote
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
        guard isRemote else { return }
        sendJSON(["type": "rc-subscribe", "sessionId": sessionId])
    }

    private func scheduleReconnect() {
        guard !intentionalClose else { return }
        task = nil
        reconnectAttempts += 1
        let delay = min(pow(2.0, Double(reconnectAttempts)), 15.0)
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
        var shown = trimmed
        if !attachments.isEmpty {
            let names = attachments.compactMap { $0["name"] }.map { "📎 \($0)" }.joined(separator: "\n")
            shown = shown.isEmpty ? names : shown + "\n" + names
        }
        appendOrReplace(ChatMessage(id: "local-\(nextSeq())", kind: "text", role: "user", content: shown))
        isLoading = true
        var options: [String: Any] = [:]
        if isRemote {
            options["sessionId"] = sessionId
            options["resume"] = true
            options["remoteControl"] = sessionId
        } else {
            // Local project session: the server spawns/reattaches the CLI in the
            // project directory. Empty sessionId = brand-new conversation; the
            // session_created frame below rebinds us to the real id.
            if let projectPath { options["projectPath"] = projectPath; options["cwd"] = projectPath }
            if !sessionId.isEmpty { options["sessionId"] = sessionId; options["resume"] = true }
        }
        if !attachments.isEmpty { options["images"] = attachments }
        sendJSON(["type": "claude-command", "command": trimmed, "options": options])
    }

    func answerPermission(requestId: String, allow: Bool) {
        sendJSON(["type": "claude-permission-response", "requestId": requestId, "allow": allow])
        pendingPermission = nil
    }

    func abort() {
        sendJSON(["type": "abort-session", "sessionId": sessionId, "provider": "claude"])
        isLoading = false
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

        if type == "session-status" {
            if let processing = obj["isProcessing"] as? Bool { isLoading = processing }
            if let status = obj["status"] as? [String: Any], let t = status["text"] as? String { statusText = t }
            return
        }

        switch kind {
        case "stream_delta":
            appendStream(obj["content"] as? String ?? "")
            isLoading = true
        case "stream_end":
            streamingId = nil
        case "text":
            streamingId = nil
            let role = obj["role"] as? String ?? "assistant"
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
            var m = ChatMessage(id: messageId(obj), kind: "permission_request", role: "assistant",
                                toolName: obj["toolName"] as? String)
            m.requestId = obj["requestId"] as? String
            pendingPermission = m
        case "session_created":
            // A new local conversation gets its real id at turn start — rebind so
            // resumes and history reads target the actual session.
            if !isRemote, let newId = (obj["newSessionId"] as? String) ?? (obj["sessionId"] as? String), !newId.isEmpty {
                sessionId = newId
            }
        case "permission_cancelled":
            pendingPermission = nil
        case "error":
            streamingId = nil
            appendOrReplace(ChatMessage(id: messageId(obj), kind: "error", role: "assistant",
                                        content: obj["content"] as? String, isError: true))
            isLoading = false
        case "complete":
            streamingId = nil
            isLoading = false
            statusText = nil
            scheduleReconcile()
        default:
            break
        }
    }

    // MARK: helpers

    private func appendStream(_ chunk: String) {
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

    private func sendJSON(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let str = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(str)) { _ in }
    }
}
