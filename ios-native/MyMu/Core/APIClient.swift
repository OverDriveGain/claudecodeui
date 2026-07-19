import Foundation

enum APIError: LocalizedError {
    case badURL
    case http(Int, String)
    case network(String)

    var errorDescription: String? {
        switch self {
        case .badURL: return "Bad URL."
        case .http(let code, let msg):
            if code == 401 { return "Invalid username or password." }
            return "Server error (HTTP \(code)). \(msg)"
        case .network(let m): return m
        }
    }
}

/// Thin REST client over the same endpoints the web app uses.
struct APIClient {
    var token: String?

    private func request(_ path: String, method: String = "GET", body: Data? = nil, auth: Bool = true) async throws -> Data {
        guard let url = URL(string: Config.serverOrigin + path) else { throw APIError.badURL }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 30
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if auth, let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }

        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await URLSession.shared.data(for: req)
        } catch {
            throw APIError.network(error.localizedDescription)
        }
        guard let http = resp as? HTTPURLResponse else { throw APIError.network("No response from server.") }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.http(http.statusCode, String(data: data, encoding: .utf8) ?? "")
        }
        return data
    }

    // MARK: Endpoints

    static func login(username: String, password: String) async throws -> LoginResponse {
        let body = try JSONEncoder().encode(["username": username, "password": password])
        let data = try await APIClient(token: nil).request("/api/auth/login", method: "POST", body: body, auth: false)
        return try JSONDecoder().decode(LoginResponse.self, from: data)
    }

    struct AgentStatusEntry: Codable { let id: String; let running: Bool?; let connected: Bool? }
    private struct AgentStatusResponse: Codable { let agents: [AgentStatusEntry] }

    /// Lightweight live status for remote agents ({id, running, connected}) —
    /// served from a short server cache, safe to poll every few seconds.
    func agentStatus() async throws -> [AgentStatusEntry] {
        let data = try await request("/api/projects/agent-status")
        return try JSONDecoder().decode(AgentStatusResponse.self, from: data).agents
    }

    func projects() async throws -> [Project] {
        let data = try await request("/api/projects")
        return try JSONDecoder().decode(ProjectsEnvelope.self, from: data).projects
    }

    func archivedProjects() async throws -> [Project] {
        let data = try await request("/api/projects/archived")
        return try JSONDecoder().decode(ProjectsEnvelope.self, from: data).projects
    }

    /// Lazy tree loading: `depth` bounds the server-side walk (cut-off dirs come
    /// back `truncated`), `path` re-roots it at a subdirectory for on-demand
    /// expansion — the whole-tree eager walk was multi-MB and crawled on
    /// network-mounted folders.
    func files(projectId: String, path: String? = nil, depth: Int = 2) async throws -> [FileNode] {
        let pid = projectId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? projectId
        var endpoint = "/api/projects/\(pid)/files?depth=\(depth)"
        if let path, !path.isEmpty {
            let p = path.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? path
            endpoint += "&path=\(p)"
        }
        let data = try await request(endpoint)
        return try JSONDecoder().decode([FileNode].self, from: data)
    }

    func fileText(projectId: String, filePath: String) async throws -> String {
        struct R: Codable { let content: String }
        let pid = projectId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? projectId
        let fp = filePath.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? filePath
        let data = try await request("/api/projects/\(pid)/file?filePath=\(fp)")
        return try JSONDecoder().decode(R.self, from: data).content
    }

    func history(sessionId: String, limit: Int = 200, offset: Int = 0) async throws -> HistoryResponse {
        let sid = sessionId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionId
        let data = try await request("/api/providers/sessions/\(sid)/messages?limit=\(limit)&offset=\(offset)")
        return try JSONDecoder().decode(HistoryResponse.self, from: data)
    }
}
