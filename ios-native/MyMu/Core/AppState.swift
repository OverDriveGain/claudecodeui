import SwiftUI

/// App-wide auth + session. Token is persisted in the Keychain; the app reuses
/// the same login the web client does (`POST /api/auth/login`).
@MainActor
final class AppState: ObservableObject {
    @Published var token: String?
    @Published var user: User?

    private let tokenAccount = "auth-token"
    private let userKey = "mymu.user"

    init() {
        token = Keychain.get(tokenAccount)
        if let data = UserDefaults.standard.data(forKey: userKey),
           let u = try? JSONDecoder().decode(User.self, from: data) {
            user = u
        }
    }

    var isAuthenticated: Bool { token != nil }
    var api: APIClient { APIClient(token: token) }

    func login(username: String, password: String) async throws {
        let resp = try await APIClient.login(username: username, password: password)
        token = resp.token
        user = resp.user
        Keychain.set(resp.token, for: tokenAccount)
        if let data = try? JSONEncoder().encode(resp.user) {
            UserDefaults.standard.set(data, forKey: userKey)
        }
    }

    func logout() {
        token = nil
        user = nil
        Keychain.set(nil, for: tokenAccount)
        UserDefaults.standard.removeObject(forKey: userKey)
    }
}
