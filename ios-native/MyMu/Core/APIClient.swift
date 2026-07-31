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

/// Thin REST client over the stock claudecodeui endpoints.
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
        return Self.unwrapEnvelope(data)
    }

    /// claudecodeui servers wrap most REST payloads in a
    /// `{success: true, data: …}` envelope, but not every endpoint is wrapped
    /// (login, some bare arrays). Unwrap the envelope when it is the entire
    /// response; responses that merely contain a `success` flag among other
    /// fields (e.g. login) pass through untouched.
    private static func unwrapEnvelope(_ data: Data) -> Data {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              obj.count == 2,
              obj["success"] as? Bool == true,
              let inner = obj["data"],
              let unwrapped = try? JSONSerialization.data(withJSONObject: inner, options: [.fragmentsAllowed])
        else { return data }
        return unwrapped
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

    /// Lazy tree loading: `depth` bounds the server-side walk (cut-off dirs come
    /// back `truncated`), `path` re-roots it at a subdirectory for on-demand
    /// expansion — the whole-tree eager walk was multi-MB and crawled on
    /// network-mounted folders.
    func files(projectId: String, path: String? = nil, depth: Int = 2) async throws -> [FileNode] {
        let pid = projectId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? projectId
        var endpoint = "/api/file-tree/projects/\(pid)/files?depth=\(depth)"
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
        let data = try await request("/api/file-tree/projects/\(pid)/file?filePath=\(fp)")
        return try JSONDecoder().decode(R.self, from: data).content
    }

    func history(sessionId: String, limit: Int = 200, offset: Int = 0) async throws -> HistoryResponse {
        let sid = sessionId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionId
        let data = try await request("/api/providers/sessions/\(sid)/messages?limit=\(limit)&offset=\(offset)")
        return try JSONDecoder().decode(HistoryResponse.self, from: data)
    }

    struct AssetRecord: Codable {
        let name: String?
        let path: String
        let size: Int?
        let mimeType: String?
    }

    /// Uploads chat attachments to the server's asset store (the standard
    /// claudecodeui flow: store first, then reference by path in chat.send).
    /// `field` is "images" for image files or "files" for anything else — it
    /// names both the route and the multipart field.
    func uploadAssets(_ attachments: [(name: String, mime: String, bytes: Data)], field: String) async throws -> [AssetRecord] {
        guard !attachments.isEmpty else { return [] }
        guard let url = URL(string: Config.serverOrigin + "/api/assets/\(field)") else { throw APIError.badURL }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 300
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let boundary = "mymu-\(UUID().uuidString)"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        var body = Data()
        for attachment in attachments {
            let safeName = attachment.name.replacingOccurrences(of: "\"", with: "_")
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"\(field)\"; filename=\"\(safeName)\"\r\n".data(using: .utf8)!)
            body.append("Content-Type: \(attachment.mime)\r\n\r\n".data(using: .utf8)!)
            body.append(attachment.bytes)
            body.append("\r\n".data(using: .utf8)!)
        }
        body.append("--\(boundary)--\r\n".data(using: .utf8)!)
        req.httpBody = body

        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await URLSession.shared.data(for: req)
        } catch {
            throw APIError.network(error.localizedDescription)
        }
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            throw APIError.http(code, String(data: data, encoding: .utf8) ?? "")
        }
        struct R: Codable { let images: [AssetRecord]?; let attachments: [AssetRecord]? }
        let decoded = try JSONDecoder().decode(R.self, from: Self.unwrapEnvelope(data))
        return decoded.images ?? decoded.attachments ?? []
    }

    /// claudecodeui allocates a chat session over REST before the first
    /// `chat.send`. Returns the new session id.
    func createProviderSession(provider: String = "claude", projectPath: String) async throws -> String {
        struct R: Codable { let sessionId: String }
        let body = try JSONEncoder().encode(["provider": provider, "projectPath": projectPath])
        let data = try await request("/api/providers/sessions", method: "POST", body: body)
        return try JSONDecoder().decode(R.self, from: data).sessionId
    }
}
