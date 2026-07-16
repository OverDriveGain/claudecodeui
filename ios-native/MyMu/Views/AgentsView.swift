import SwiftUI

/// Live remote-control agents — the default tab. Non-expandable leaf rows with a
/// status dot, exactly like MyMu's Agents view. (NavigationStack + path live in
/// MainTabView so tab switches keep your place.)
struct AgentsView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var store: ProjectsStore

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            content
        }
        .navigationTitle("Agents")
        .toolbarBackground(Theme.background, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar { ToolbarItem(placement: .navigationBarTrailing) { ProfileMenu() } }
    }

    @ViewBuilder
    private var content: some View {
        if store.loading && store.projects.isEmpty {
            MyMuLoader().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if store.agents.isEmpty {
            EmptyStateView(text: store.error ?? "No agents found.") { Task { await store.load(appState.api) } }
        } else {
            List(store.agents) { agent in
                NavigationLink(value: Route.chat(ChatTarget(
                    sessionId: agent.remoteSessionId ?? agent.projectId.replacingOccurrences(of: "remote:", with: ""),
                    projectId: agent.projectId, isRemote: true, title: agent.displayName))) {
                    row(agent)
                }
                .listRowBackground(Color.clear)
                .listRowSeparatorTint(Theme.border)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .refreshable { await store.load(appState.api) }
        }
    }

    private func row(_ p: Project) -> some View {
        HStack(spacing: 12) {
            IconTile(symbol: "terminal")
            VStack(alignment: .leading, spacing: 3) {
                Text(p.displayName).foregroundColor(Theme.text).font(.body).lineLimit(1)
                HStack(spacing: 5) {
                    Circle().fill(AgentStatus.color(p)).frame(width: 7, height: 7)
                    Text(AgentStatus.text(p)).font(.caption2).foregroundColor(Theme.mutedText)
                }
            }
            Spacer()
            if p.remoteRunning == true { ProgressView().scaleEffect(0.7).tint(Theme.primary) }
        }
        .padding(.vertical, 4)
        .opacity(AgentStatus.dimmed(p) ? 0.6 : 1)
    }
}
