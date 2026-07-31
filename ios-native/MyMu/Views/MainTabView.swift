import SwiftUI

/// MyMu's top-level IA as a native tab bar — Agents (default), Projects, Chats,
/// Archive. Each tab's NavigationStack PATH lives here: MainTabView never leaves
/// the hierarchy, so switching tabs preserves exactly where you were in each one.
struct MainTabView: View {
    @EnvironmentObject var appState: AppState
    @StateObject private var store: ProjectsStore
    @State private var selection: Int
    @State private var agentsPath: [Route] = []
    @State private var projectsPath: [Route] = []
    @State private var chatsPath: [Route] = []
    @State private var archivePath: [Route] = []

    @MainActor
    init(store: ProjectsStore? = nil) {
        _store = StateObject(wrappedValue: store ?? ProjectsStore())
        var initial = 0
        if let t = ProcessInfo.processInfo.environment["MYMU_DEMO_TAB"], let n = Int(t) { initial = n }
        _selection = State(initialValue: initial)
    }

    var body: some View {
        TabView(selection: $selection) {
            NavigationStack(path: $agentsPath) {
                AgentsView().navigationDestination(for: Route.self) { RouteView(route: $0) }
            }
            .tabItem { Label("Agents", systemImage: "terminal") }
            .tag(0)

            NavigationStack(path: $projectsPath) {
                ProjectsView().navigationDestination(for: Route.self) { RouteView(route: $0) }
            }
            .tabItem { Label("Projects", systemImage: "folder") }
            .tag(1)

            NavigationStack(path: $chatsPath) {
                RecentsView().navigationDestination(for: Route.self) { RouteView(route: $0) }
            }
            .tabItem { Label("Chats", systemImage: "message") }
            .tag(2)

            NavigationStack(path: $archivePath) {
                ArchiveView().navigationDestination(for: Route.self) { RouteView(route: $0) }
            }
            .tabItem { Label("Archive", systemImage: "archivebox") }
            .tag(3)
        }
        .environmentObject(store)
        .tint(Theme.primary)
        .task { await store.loadIfNeeded(appState.api) }
    }
}
