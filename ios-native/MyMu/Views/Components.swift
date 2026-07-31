import SwiftUI
import UIKit

/// Visible copy affordance under a message (the web shows an explicit button, not
/// a long-press). Shows a brief "Copied" confirmation.
struct CopyButton: View {
    let text: String
    @State private var copied = false
    var body: some View {
        Button {
            UIPasteboard.general.string = text
            copied = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { copied = false }
        } label: {
            Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                .font(.caption2)
                .foregroundColor(Theme.mutedText)
        }
        .buttonStyle(.plain)
    }
}

/// Rounded square icon tile used across list rows.
struct IconTile: View {
    let symbol: String
    var size: CGFloat = 38
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 10).fill(Theme.surface).frame(width: size, height: size)
            Image(systemName: symbol).foregroundColor(Theme.primary).font(.system(size: size * 0.42))
        }
    }
}

/// Centered empty / hint state.
struct EmptyStateView: View {
    let text: String
    var retry: (() -> Void)? = nil
    var body: some View {
        VStack(spacing: 10) {
            Text(text).foregroundColor(Theme.mutedText).multilineTextAlignment(.center)
            if let retry {
                Button("Retry", action: retry).foregroundColor(Theme.primary)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Account switcher menu — Gmail-style multiple logins. Each saved account is a
/// (server, user) pair; tapping one switches the WHOLE environment to it. "Add
/// account" opens the same login screen pointed at any server.
struct ProfileMenu: View {
    @EnvironmentObject var appState: AppState
    @State private var showAddAccount = false
    var body: some View {
        Menu {
            ForEach(appState.accounts) { acct in
                Button {
                    appState.switchTo(acct)
                } label: {
                    if acct.id == appState.activeAccountId {
                        Label("\(acct.username) · \(acct.hostLabel)", systemImage: "checkmark")
                    } else {
                        Text("\(acct.username) · \(acct.hostLabel)")
                    }
                }
            }
            Divider()
            Button {
                showAddAccount = true
            } label: {
                Label("Add account", systemImage: "plus")
            }
            Button("Sign out", role: .destructive) { appState.logout() }
            Divider()
            // Which build is on this phone — version from the marketing string,
            // build stamped per dev install (CURRENT_PROJECT_VERSION on the CLI).
            Text("App v\(Bundle.main.appVersionLabel)")
        } label: {
            Image(systemName: "person.crop.circle").foregroundColor(Theme.primary)
        }
        .sheet(isPresented: $showAddAccount) {
            LoginView(onSuccess: { showAddAccount = false })
        }
    }
}

extension Bundle {
    /// "1.0.0 (250725.2114)" — marketing version + build number.
    var appVersionLabel: String {
        let v = infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let b = infoDictionary?["CFBundleVersion"] as? String ?? "?"
        return "\(v) (\(b))"
    }
}

/// Compact relative age ("<1m", "5m", "3hr", "2d") — mirrors formatCompactSessionAge.
func compactAge(_ iso: String?) -> String {
    guard let iso, let date = parseISO(iso) else { return "" }
    let s = Date().timeIntervalSince(date)
    if s < 60 { return "<1m" }
    if s < 3600 { return "\(Int(s / 60))m" }
    if s < 86400 { return "\(Int(s / 3600))hr" }
    return "\(Int(s / 86400))d"
}

private func parseISO(_ s: String) -> Date? {
    let f1 = ISO8601DateFormatter()
    f1.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f1.date(from: s) { return d }
    let f2 = ISO8601DateFormatter()
    f2.formatOptions = [.withInternetDateTime]
    return f2.date(from: s)
}
