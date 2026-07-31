import Foundation

// MARK: - Auth

struct LoginResponse: Codable {
    let success: Bool?
    let token: String
    let user: User
}

struct User: Codable, Equatable {
    let id: Int
    let username: String
}

// MARK: - Projects & sessions (mirror of the web app's /api/projects shape)

struct Project: Codable, Identifiable, Equatable, Hashable {
    var id: String { projectId }
    let projectId: String
    let displayName: String
    let fullPath: String?
    let path: String?
    let isStarred: Bool?
    let sessions: [Session]?
    // Set only for virtual `remote:<id>` projects — a live `claude --remote-control` agent.
    let isRemoteAgent: Bool?
    let remoteSessionId: String?
    var remoteConnected: Bool?
    var remoteRunning: Bool?

    /// The one session this project's chat drives. For a remote agent that's the
    /// relay session; for a local project the caller picks from `sessions`.
    var primarySessionId: String? { isRemoteAgent == true ? remoteSessionId : sessions?.first?.id }
}

struct Session: Codable, Identifiable, Equatable, Hashable {
    let id: String
    let title: String?
    let summary: String?
    let name: String?
    let lastActivity: String?
    let updated_at: String?
    let created_at: String?
    let createdAt: String?
    let messageCount: Int?

    var displayTitle: String {
        for c in [title, summary, name] {
            if let c, !c.isEmpty { return c }
        }
        return id
    }

    /// Recency key, matching the web app's sessionTime() precedence.
    var sortKey: String { updated_at ?? lastActivity ?? createdAt ?? created_at ?? "" }
}

/// `/api/projects` may return a bare array or `{ projects: [...] }` — decode either.
struct ProjectsEnvelope: Codable {
    let projects: [Project]
    init(from decoder: Decoder) throws {
        if let arr = try? [Project](from: decoder) {
            projects = arr
        } else {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            projects = (try? c.decode([Project].self, forKey: .projects)) ?? []
        }
    }
    enum CodingKeys: String, CodingKey { case projects }
}

// MARK: - Chat messages (mirror of NormalizedMessage; lenient decode)

struct ChatMessage: Codable, Identifiable, Equatable {
    var id: String
    var kind: String
    var role: String? = nil
    var content: String? = nil
    var text: String? = nil
    var displayText: String? = nil
    var toolName: String? = nil
    var toolId: String? = nil
    var status: String? = nil
    var summary: String? = nil
    var requestId: String? = nil
    var isError: Bool? = nil
    var timestamp: String? = nil
    /// Harness-injected content shipped as a user-role row (skill payloads,
    /// synthetic context) — the person did NOT type it; rendered as a collapsed
    /// context chip on the agent side, never as a user bubble.
    var isInjected: Bool? = nil
    /// Arbitrary tool input / result / permission payload (rendered richly later).
    var toolInput: AnyCodable? = nil
    var input: AnyCodable? = nil
    var toolResult: AnyCodable? = nil
    /// Images attached to this message, as `data:` URLs — set for a user message
    /// that carried photos/screenshots so the bubble shows them, not just a chip.
    var images: [String]? = nil

    enum CodingKeys: String, CodingKey {
        case id, kind, role, content, text, displayText, toolName, toolId
        case status, summary, requestId, isError, timestamp, isInjected, toolInput, input, toolResult, images
    }

    /// The human-visible body for a simple text bubble.
    var bodyText: String {
        displayText ?? content ?? text ?? ""
    }
}

// Tolerant decoding: one message whose field arrives in an unexpected shape (a
// `content` array of blocks, a null where a string was expected, a stray type)
// must NEVER throw and blank the entire transcript. Every field decodes with a
// fallback; text-bearing fields also flatten block arrays into their text.
extension ChatMessage {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        kind = (try? c.decode(String.self, forKey: .kind)) ?? "text"
        role = try? c.decode(String.self, forKey: .role)
        content = ChatMessage.looseText(c, .content)
        text = ChatMessage.looseText(c, .text)
        displayText = ChatMessage.looseText(c, .displayText)
        toolName = try? c.decode(String.self, forKey: .toolName)
        toolId = try? c.decode(String.self, forKey: .toolId)
        status = try? c.decode(String.self, forKey: .status)
        summary = ChatMessage.looseText(c, .summary)
        requestId = try? c.decode(String.self, forKey: .requestId)
        isError = try? c.decode(Bool.self, forKey: .isError)
        timestamp = try? c.decode(String.self, forKey: .timestamp)
        isInjected = try? c.decode(Bool.self, forKey: .isInjected)
        toolInput = try? c.decode(AnyCodable.self, forKey: .toolInput)
        input = try? c.decode(AnyCodable.self, forKey: .input)
        toolResult = try? c.decode(AnyCodable.self, forKey: .toolResult)
        images = try? c.decode([String].self, forKey: .images)
    }

    /// A string field that may instead arrive as blocks (`[{type:"text",text:…}]`)
    /// or an object — flatten to text rather than throwing.
    private static func looseText(_ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> String? {
        if let s = try? c.decode(String.self, forKey: key) { return s }
        if let any = try? c.decode(AnyCodable.self, forKey: key) { return flattenText(any.value) }
        return nil
    }

    private static func flattenText(_ v: Any) -> String? {
        if let s = v as? String { return s }
        if let arr = v as? [Any] {
            let parts = arr.compactMap { flattenText($0) }
            return parts.isEmpty ? nil : parts.joined(separator: "\n")
        }
        if let d = v as? [String: Any] {
            if let t = d["text"] as? String { return t }
            if let inner = d["content"] { return flattenText(inner) }
        }
        return nil
    }
}

// MARK: - File tree

struct FileNode: Codable, Identifiable, Equatable {
    var id: String { path }
    let name: String
    let path: String
    let type: String   // "directory" | "file"
    let size: Int?
    let children: [FileNode]?
    /// Directory exists but wasn't walked (depth cutoff or mount boundary) —
    /// fetch its contents on demand when the user opens it.
    let truncated: Bool?

    var isDir: Bool { type == "directory" }
    /// True when this directory's children must be fetched before showing.
    var needsFetch: Bool { isDir && (truncated == true || children == nil) }
    var sortedChildren: [FileNode] {
        (children ?? []).sorted {
            if $0.isDir != $1.isDir { return $0.isDir && !$1.isDir }
            return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }
}

struct ContextUsage: Codable, Equatable {
    let usedTokens: Int
    let windowTokens: Int
    /// 0…1 fullness of the agent's context window.
    var fraction: Double { windowTokens > 0 ? min(1, Double(usedTokens) / Double(windowTokens)) : 0 }
}

struct HistoryResponse: Codable {
    let messages: [ChatMessage]
    let total: Int?
    let hasMore: Bool?
    let offset: Int?
    let limit: Int?
    let context: ContextUsage?
    /// ISO timestamp of the user prompt that opened a still-running turn —
    /// lets the elapsed timer anchor to the REAL turn start across reopens.
    let turnStartedAt: String?
    /// Context position (tokens) just before the open turn started — baseline
    /// for the live "tokens this turn" counter.
    let turnStartContextTokens: Int?
}

// Tolerant decoding: a wrong-typed meta field (e.g. total as a string, an
// unexpected context shape) must not sink the whole transcript. Messages already
// decode leniently per-element; everything else falls back to nil.
extension HistoryResponse {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        messages = (try? c.decode([ChatMessage].self, forKey: .messages)) ?? []
        total = try? c.decode(Int.self, forKey: .total)
        hasMore = try? c.decode(Bool.self, forKey: .hasMore)
        offset = try? c.decode(Int.self, forKey: .offset)
        limit = try? c.decode(Int.self, forKey: .limit)
        context = try? c.decode(ContextUsage.self, forKey: .context)
        turnStartedAt = try? c.decode(String.self, forKey: .turnStartedAt)
        turnStartContextTokens = try? c.decode(Int.self, forKey: .turnStartContextTokens)
    }
}

// MARK: - AnyCodable — hold arbitrary JSON for tool payloads

struct AnyCodable: Codable, Equatable {
    let value: Any

    init(_ value: Any) { self.value = value }

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { value = NSNull() }
        else if let b = try? c.decode(Bool.self) { value = b }
        else if let i = try? c.decode(Int.self) { value = i }
        else if let d = try? c.decode(Double.self) { value = d }
        else if let s = try? c.decode(String.self) { value = s }
        else if let a = try? c.decode([AnyCodable].self) { value = a.map { $0.value } }
        else if let o = try? c.decode([String: AnyCodable].self) { value = o.mapValues { $0.value } }
        else { value = NSNull() }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch value {
        case is NSNull: try c.encodeNil()
        case let b as Bool: try c.encode(b)
        case let i as Int: try c.encode(i)
        case let d as Double: try c.encode(d)
        case let s as String: try c.encode(s)
        case let a as [Any]: try c.encode(a.map { AnyCodable($0) })
        case let o as [String: Any]: try c.encode(o.mapValues { AnyCodable($0) })
        default: try c.encodeNil()
        }
    }

    static func == (lhs: AnyCodable, rhs: AnyCodable) -> Bool {
        String(describing: lhs.value) == String(describing: rhs.value)
    }

    /// Pretty-printed JSON string, for a fallback tool-payload display.
    var prettyJSON: String {
        if let s = value as? String { return s }
        if let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]),
           let str = String(data: data, encoding: .utf8) {
            return str
        }
        return String(describing: value)
    }
}
