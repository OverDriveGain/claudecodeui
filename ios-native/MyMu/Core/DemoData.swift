import Foundation

/// Sample transcript used by the DEBUG demo screen (MYMU_DEMO=1) so the chat UI
/// can be screenshotted/iterated without a live login.
enum DemoData {
    private static func agent(_ name: String, id: String, connected: Bool, running: Bool) -> Project {
        Project(projectId: "remote:\(id)", displayName: name, fullPath: nil, path: nil, isStarred: nil, sessions: nil,
                isRemoteAgent: true, remoteSessionId: id, remoteConnected: connected, remoteRunning: running)
    }

    private static func session(_ id: String, title: String, msgs: Int, ageMin: Int) -> Session {
        Session(id: id, title: title, summary: nil, name: nil, lastActivity: nil,
                updated_at: nil, created_at: nil, createdAt: nil, messageCount: msgs)
    }

    private static func folder(_ name: String, path: String, sessions: [Session]) -> Project {
        Project(projectId: name, displayName: name, fullPath: path, path: path, isStarred: nil, sessions: sessions,
                isRemoteAgent: false, remoteSessionId: nil, remoteConnected: nil, remoteRunning: nil)
    }

    static let projects: [Project] = [
        agent("special-agent", id: "cse_a1", connected: true, running: true),
        agent("casabot-monitor", id: "cse_b2", connected: true, running: false),
        agent("quotomate-dev", id: "cse_c3", connected: false, running: false),
        folder("claudecodeui", path: "/home/manar/Projects/claudecodeui", sessions: [
            session("s1", title: "Native iOS app — MyMu chat", msgs: 214, ageMin: 3),
            session("s2", title: "Fix delivered-file video streaming", msgs: 48, ageMin: 90),
        ]),
        folder("mnemos", path: "/home/manar/Projects/mnemos", sessions: [
            session("s3", title: "pgvector ingest pipeline", msgs: 132, ageMin: 1440),
        ]),
    ]

    static let messages: [ChatMessage] = [
        ChatMessage(id: "d1", kind: "text", role: "user",
                    content: "Can you refactor the auth module and show me a quick example?"),
        ChatMessage(id: "d2", kind: "text", role: "assistant",
                    content: """
                    Sure — here's the plan:

                    1. Extract **`validateToken`** into its own helper
                    2. Add refresh handling with a fallback

                    ```swift
                    func validateToken(_ token: String) -> Bool {
                        guard !token.isEmpty else { return false }
                        return token.hasPrefix("ey")
                    }
                    ```

                    That keeps the call sites clean. Want me to apply it?
                    """),
        ChatMessage(id: "d3", kind: "tool_use", role: "assistant", toolName: "Edit"),
        ChatMessage(id: "d4", kind: "tool_result", role: "assistant",
                    content: "Applied 2 edits to auth.swift (+18 −6)"),
        ChatMessage(id: "d5", kind: "text", role: "assistant",
                    content: "Done ✅ — the auth module now validates and refreshes tokens. Anything else?"),
    ]

    /// A LONG, mixed transcript (tall enough to scroll) for reproducing the
    /// scroll-to-bottom overshoot / phantom-gap bug in the simulator.
    static var longMessages: [ChatMessage] {
        var out: [ChatMessage] = []
        for i in 0..<24 {
            out.append(ChatMessage(id: "u\(i)", kind: "text", role: "user",
                                   content: "Question number \(i): can you look into part \(i) of the module and explain what it does in a couple of sentences?"))
            out.append(ChatMessage(id: "tu\(i)", kind: "tool_use", role: "assistant", toolName: "Read"))
            out.append(ChatMessage(id: "tr\(i)", kind: "tool_result", role: "assistant",
                                   content: "Read module/part_\(i).swift (\(40 + i) lines)"))
            out.append(ChatMessage(id: "a\(i)", kind: "text", role: "assistant",
                                   content: """
                                   Part \(i) handles the \(i.isMultiple(of: 2) ? "encoding" : "validation") path. It takes the raw input, \
                                   normalizes it, and returns a typed result. The tricky bit is the fallback branch that runs when \
                                   the primary source is unavailable — it retries with a shorter timeout and then degrades gracefully.
                                   """))
        }
        return out
    }
}
