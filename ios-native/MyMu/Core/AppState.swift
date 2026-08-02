import SwiftUI

/// A saved login: one server + one user on it. Gmail-style — the app keeps a
/// list of these and exactly ONE is active at a time; switching swaps the whole
/// environment (server origin, token, everything reconnects). Tokens live in
/// the Keychain per account; this struct is what persists in UserDefaults.
struct SavedAccount: Codable, Identifiable, Equatable {
    let serverOrigin: String
    let username: String
    var id: String { "\(serverOrigin)|\(username)" }
    /// Full display host, e.g. "code.kaxtus.com".
    var hostLabel: String {
        serverOrigin
            .replacingOccurrences(of: "https://", with: "")
            .replacingOccurrences(of: "http://", with: "")
    }

    /// One-word host for menu rows, e.g. "kaxtus", "thinkpad", "box", "ccuitest".
    /// Full FQDNs hyphen-wrap across three lines in a Menu, which makes the
    /// account list unreadable once you have more than a couple of logins.
    /// Hosts with a port (dev/IP origins) are kept verbatim — there's no
    /// meaningful name to shorten to.
    var shortHostLabel: String {
        let host = hostLabel
        guard !host.contains(":") else { return host }
        let parts = host.split(separator: ".").map(String.init)
        guard let first = parts.first else { return host }
        // "code.kaxtus.com" → the domain ("kaxtus"); "code-box.kaxtus.com" →
        // the machine ("box"); anything else → its own first label.
        if first == "code" { return parts.count > 1 ? parts[1] : first }
        if first.hasPrefix("code-") { return String(first.dropFirst("code-".count)) }
        return first
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
    /// Agent → host assignments from the server (agent title → host origin).
    /// Admin-set pinning: which CCUI host an agent runs on. Drives per-chat
    /// routing so file sends land on the agent's machine.
    @Published var agentHostAssignments: [String: String] = [:]

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

    // MARK: Agent → host routing

    /// Refresh the admin-set agent→host map from the active server. Cheap; call
    /// when the agents list loads and after account switches.
    func refreshAgentHosts() async {
        guard token != nil, !isDemo else { return }
        if let map = try? await api.agentHosts() {
            agentHostAssignments = map
        }
    }

    /// Where a pinned agent's conversation should connect: the assigned host +
    /// the saved account's token for it. nil = the active host (unpinned, pinned
    /// to the active host itself, or no saved login for the assigned host —
    /// callers pair this with `pinnedHostNeedingLogin` for the file warning).
    /// The key is the agent's title — same stable identity the web view uses
    /// (single claude.ai account per host, so no account-label prefix).
    func routeForAgent(title: String) -> (origin: String, token: String)? {
        guard let assigned = agentHostAssignments[title] else { return nil }
        let origin = Config.normalize(assigned)
        guard origin != Config.normalize(Config.serverOrigin) else { return nil }
        guard let acct = accounts.first(where: { Config.normalize($0.serverOrigin) == origin }),
              let tok = Keychain.get(accountTokenKey(acct.id)) else { return nil }
        return (origin, tok)
    }

    /// Host label when the agent is pinned to a host the app has NO saved login
    /// for — arbitrary files can't reach it; the composer warns and points the
    /// user at "Add account". nil when routing works (or nothing is pinned).
    func pinnedHostNeedingLogin(title: String) -> String? {
        guard let assigned = agentHostAssignments[title] else { return nil }
        let origin = Config.normalize(assigned)
        guard origin != Config.normalize(Config.serverOrigin) else { return nil }
        let hasLogin = accounts.contains { acct in
            Config.normalize(acct.serverOrigin) == origin && Keychain.get(accountTokenKey(acct.id)) != nil
        }
        return hasLogin ? nil : origin
            .replacingOccurrences(of: "https://", with: "")
            .replacingOccurrences(of: "http://", with: "")
    }

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
            // Fall over to the next account that still has a usable token. Clear the
            // stale active token FIRST so we can never end up "authenticated"
            // (token != nil) with no active account when no fallover token survives —
            // that stranded the app on a dead session instead of the login screen.
            activeAccountId = nil
            token = nil
            if let next = accounts.first(where: { Keychain.get(accountTokenKey($0.id)) != nil }) {
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
