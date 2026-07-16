import SwiftUI

/// Value-based navigation targets. Each tab's path ([Route]) is OWNED BY
/// MainTabView, which never leaves the hierarchy — so switching tabs and coming
/// back restores exactly where you were (list, detail, or deep in a chat).
struct ChatTarget: Hashable {
    let sessionId: String
    let projectId: String
    let isRemote: Bool
    let title: String
    var projectPath: String? = nil
}

enum Route: Hashable {
    case chat(ChatTarget)
    case projectDetail(Project)
}

/// Resolves a Route to its screen. Registered once per tab's NavigationStack.
struct RouteView: View {
    let route: Route
    @EnvironmentObject var appState: AppState

    var body: some View {
        switch route {
        case .chat(let t):
            ChatView(sessionId: t.sessionId, projectId: t.projectId, isRemote: t.isRemote,
                     title: t.title, token: appState.token ?? "", projectPath: t.projectPath)
        case .projectDetail(let p):
            ProjectDetailView(project: p)
        }
    }
}
