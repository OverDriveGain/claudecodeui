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
            // Agent→host pinning: a remote agent assigned to another host — with a
            // saved login there — gets its WHOLE conversation (WS, history, files)
            // routed to that host, so file sends land on the agent's machine. The
            // relay mirrors turns to every attached host, so nothing else changes.
            let hostRoute = t.isRemote ? appState.routeForAgent(title: t.title) : nil
            ChatView(sessionId: t.sessionId, projectId: t.projectId, isRemote: t.isRemote,
                     title: t.title, token: hostRoute?.token ?? appState.token ?? "",
                     projectPath: t.projectPath, origin: hostRoute?.origin,
                     pinnedHostNeedingLogin: t.isRemote ? appState.pinnedHostNeedingLogin(title: t.title) : nil)
        case .projectDetail(let p):
            ProjectDetailView(project: p)
        }
    }
}
