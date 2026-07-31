import Foundation

/// Server the app talks to. The native client uses the exact same REST + `/ws`
/// API the MyMu web client does, just pointed at a user-configurable origin.
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
    /// `origin` overrides the active server for a conversation routed to the
    /// agent's assigned host (agent→host pinning); nil = active account's host.
    static func webSocketURL(token: String, origin: String? = nil) -> URL {
        let wsOrigin = (origin ?? serverOrigin)
            .replacingOccurrences(of: "https://", with: "wss://")
            .replacingOccurrences(of: "http://", with: "ws://")
        var comps = URLComponents(string: wsOrigin + "/ws")!
        comps.queryItems = [URLQueryItem(name: "token", value: token)]
        return comps.url!
    }

    /// Authenticated streaming URL for a delivered/preview file (media can't set
    /// an Authorization header, so the token rides as ?token= — the server accepts it).
    /// `origin` overrides the host for routed conversations (files live on the
    /// agent's assigned host, not the active account's).
    static func fileStreamURL(projectId: String, path: String, token: String, delivered: Bool, origin: String? = nil) -> URL? {
        let encodedId = projectId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? projectId
        // File browser previews use the stock file-tree path; delivered files
        // (agent SendUserFile) keep the fork's delivered-file route.
        let base = delivered
            ? "/api/projects/\(encodedId)/delivered-file"
            : "/api/file-tree/projects/\(encodedId)/files/content"
        var comps = URLComponents(string: (origin ?? serverOrigin) + base)
        comps?.queryItems = [
            URLQueryItem(name: "path", value: path),
            URLQueryItem(name: "token", value: token),
        ]
        return comps?.url
    }
}
