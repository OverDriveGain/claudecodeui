import Foundation

/// Server the app talks to. The native client uses the exact same REST + `/ws`
/// API the MyMu web client does, just pointed at a user-configurable origin.
enum Config {
    static let defaultServerOrigin = "https://code.kaxtus.com"
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

    /// Authenticated streaming URL for a delivered/preview file (media can't set
    /// an Authorization header, so the token rides as ?token= — the server accepts it).
    static func fileStreamURL(projectId: String, path: String, token: String, delivered: Bool) -> URL? {
        let route = delivered ? "delivered-file" : "files/content"
        let encodedId = projectId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? projectId
        var comps = URLComponents(string: serverOrigin + "/api/projects/\(encodedId)/\(route)")
        comps?.queryItems = [
            URLQueryItem(name: "path", value: path),
            URLQueryItem(name: "token", value: token),
        ]
        return comps?.url
    }
}
