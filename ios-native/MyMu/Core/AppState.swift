import SwiftUI

/// A saved login: one server + one user on it. Gmail-style — the app keeps a
/// list of these and exactly ONE is active at a time; switching swaps the whole
/// environment (server origin, token, everything reconnects). Tokens live in
/// the Keychain per account; this struct is what persists in UserDefaults.
struct SavedAccount: Codable, Identifiable, Equatable {
    let serverOrigin: String
    let username: String
    var id: String { "\(serverOrigin)|\(username)" }
    /// Short display host, e.g. "code.kaxtus.com".
    var hostLabel: String {
        serverOrigin
            .replacingOccurrences(of: "https://", with: "")
            .replacingOccurrences(of: "http://", with: "")
    }
}

/// App-wide auth + session. The active account's token is persisted in the
/// Keychain (legacy key kept so every existing consumer stays unchanged); the
/// app reuses the same login the web client does (`POST /api/auth/login`).
@MainActor
final class AppState: ObservableObject {
    @Published var token: String?
    @Published var user: User?
    @Published var accounts: [SavedAccount] = []
    @Published var activeAccountId: String?
    /// Bumped on every account switch — RootView re-ids the tab tree on it so
    /// stores/sockets rebuild against the new environment.
    @Published var accountEpoch = 0
    /// Local, network-free preview (canned DemoData) — used by the "Try the demo"
    /// button on the login screen so the app is reviewable/explorable with no server.
    @Published var isDemo = false

    private let tokenAccount = "auth-token" // legacy + always-the-ACTIVE-account token
    private let userKey = "mymu.user"
    private let accountsKey = "mymu.accounts"
    private let activeKey = "mymu.activeAccount"

    private func accountTokenKey(_ id: String) -> String { "auth-token|\(id)" }
    private func accountUserKey(_ id: String) -> String { "mymu.user|\(id)" }

    init() {
        token = Keychain.get(tokenAccount)
        if let data = UserDefaults.standard.data(forKey: userKey),
           let u = try? JSONDecoder().decode(User.self, from: data) {
            user = u
        }
        if let data = UserDefaults.standard.data(forKey: accountsKey),
           let list = try? JSONDecoder().decode([SavedAccount].self, from: data) {
            accounts = list
        }
        activeAccountId = UserDefaults.standard.string(forKey: activeKey)
        // Migration: a pre-accounts install has a lone token+user — adopt it as
        // the first saved account so the switcher starts populated.
        if accounts.isEmpty, let token, let user {
            let acct = SavedAccount(serverOrigin: Config.serverOrigin, username: user.username)
            accounts = [acct]
            activeAccountId = acct.id
            Keychain.set(token, for: accountTokenKey(acct.id))
            persistAccounts()
        }
    }

    var isAuthenticated: Bool { token != nil }
    var api: APIClient { APIClient(token: token) }
    var activeAccount: SavedAccount? { accounts.first { $0.id == activeAccountId } }

    func enterDemo() { isDemo = true }

    private func persistAccounts() {
        if let data = try? JSONEncoder().encode(accounts) {
            UserDefaults.standard.set(data, forKey: accountsKey)
        }
        UserDefaults.standard.set(activeAccountId, forKey: activeKey)
    }

    /// Sign in to (or add) an account on the CURRENT Config.serverOrigin and
    /// make it active. Same call for first login and Gmail-style "Add account".
    func login(username: String, password: String) async throws {
        let resp = try await APIClient.login(username: username, password: password)
        let acct = SavedAccount(serverOrigin: Config.serverOrigin, username: resp.user.username)
        accounts.removeAll { $0.id == acct.id }
        accounts.append(acct)
        Keychain.set(resp.token, for: accountTokenKey(acct.id))
        if let data = try? JSONEncoder().encode(resp.user) {
            UserDefaults.standard.set(data, forKey: accountUserKey(acct.id))
        }
        activate(acct, token: resp.token, user: resp.user)
    }

    /// Switch the whole environment to a saved account (Gmail-style).
    func switchTo(_ account: SavedAccount) {
        guard account.id != activeAccountId else { return }
        guard let saved = Keychain.get(accountTokenKey(account.id)) else {
            // Token lost/expired-away — drop the entry; user re-adds via login.
            removeAccount(account)
            return
        }
        var savedUser: User? = nil
        if let data = UserDefaults.standard.data(forKey: accountUserKey(account.id)) {
            savedUser = try? JSONDecoder().decode(User.self, from: data)
        }
        activate(account, token: saved, user: savedUser ?? User(id: 0, username: account.username))
    }

    private func activate(_ account: SavedAccount, token newToken: String, user newUser: User) {
        Config.serverOrigin = account.serverOrigin
        token = newToken
        user = newUser
        activeAccountId = account.id
        isDemo = false
        // Legacy single-token key mirrors the ACTIVE account — every existing
        // consumer (stores, media URLs) keeps reading the same place.
        Keychain.set(newToken, for: tokenAccount)
        if let data = try? JSONEncoder().encode(newUser) {
            UserDefaults.standard.set(data, forKey: userKey)
        }
        persistAccounts()
        accountEpoch += 1
    }

    /// Forget a saved account (its token included). If it was active, fall over
    /// to the next saved account, or to the login screen when none remain.
    func removeAccount(_ account: SavedAccount) {
        accounts.removeAll { $0.id == account.id }
        Keychain.set(nil, for: accountTokenKey(account.id))
        UserDefaults.standard.removeObject(forKey: accountUserKey(account.id))
        persistAccounts()
        if account.id == activeAccountId {
            if let next = accounts.first {
                activeAccountId = nil
                switchTo(next)
            } else {
                clearActive()
            }
        }
    }

    /// Sign out of the ACTIVE account only (Gmail semantics).
    func logout() {
        if let acct = activeAccount {
            removeAccount(acct)
        } else {
            clearActive()
        }
    }

    private func clearActive() {
        token = nil
        user = nil
        isDemo = false
        activeAccountId = nil
        Keychain.set(nil, for: tokenAccount)
        UserDefaults.standard.removeObject(forKey: userKey)
        persistAccounts()
        accountEpoch += 1
    }
}
