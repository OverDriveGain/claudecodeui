import Foundation

/// Server the app talks to — a stock claudecodeui server at a user-configurable
/// origin, over the same REST + `/ws` API a vanilla web client uses.
enum Config {
    static let defaultServerOrigin = "https://demo.proagenten.de"
    private static let originKey = "mymu.serverOrigin"

    static var serverOrigin: String {
        get { UserDefaults.standard.string(forKey: originKey) ?? defaultServerOrigin }
        set { UserDefaults.standard.set(normalize(newValue), forKey: originKey) }
    }

    /// Add https:// if missing, strip any path/trailing slash — keep scheme+host(+port).
    static func normalize(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return defaultServerOrigin }
        if !s.hasPrefix("http://") && !s.hasPrefix("https://") { s = "https://" + s }
        if let u = URL(string: s), let host = u.host {
            let scheme = u.scheme ?? "https"
            if let port = u.port { return "\(scheme)://\(host):\(port)" }
            return "\(scheme)://\(host)"
        }
        return s
    }

    static var apiBaseURL: URL { URL(string: serverOrigin) ?? URL(string: defaultServerOrigin)! }

    /// wss://host/ws  — the single chat/live WebSocket the web client uses.
    static func webSocketURL(token: String) -> URL {
        let wsOrigin = serverOrigin
            .replacingOccurrences(of: "https://", with: "wss://")
            .replacingOccurrences(of: "http://", with: "ws://")
        var comps = URLComponents(string: wsOrigin + "/ws")!
        comps.queryItems = [URLQueryItem(name: "token", value: token)]
        return comps.url!
    }

    /// Authenticated streaming URL for a file preview (media can't set an
    /// Authorization header, so the token rides as ?token= — the server accepts it).
    static func fileStreamURL(projectId: String, path: String, token: String) -> URL? {
        let encodedId = projectId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? projectId
        var comps = URLComponents(string: serverOrigin + "/api/projects/\(encodedId)/files/content")
        comps?.queryItems = [
            URLQueryItem(name: "path", value: path),
            URLQueryItem(name: "token", value: token),
        ]
        return comps?.url
    }
}
