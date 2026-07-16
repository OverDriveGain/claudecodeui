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

    func projects() async throws -> [Project] {
        let data = try await request("/api/projects")
        return try JSONDecoder().decode(ProjectsEnvelope.self, from: data).projects
    }

    func archivedProjects() async throws -> [Project] {
        let data = try await request("/api/projects/archived")
        return try JSONDecoder().decode(ProjectsEnvelope.self, from: data).projects
    }

    func files(projectId: String) async throws -> [FileNode] {
        let pid = projectId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? projectId
        let data = try await request("/api/projects/\(pid)/files")
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
