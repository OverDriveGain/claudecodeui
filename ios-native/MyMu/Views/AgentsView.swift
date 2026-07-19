import SwiftUI

/// Live remote-control agents — the default tab. Non-expandable leaf rows with a
/// status dot, exactly like MyMu's Agents view. (NavigationStack + path live in
/// MainTabView so tab switches keep your place.)
struct AgentsView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var store: ProjectsStore
    @State private var query = ""

    private var filtered: [Project] {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return store.agents }
        return store.agents.filter { $0.displayName.localizedCaseInsensitiveContains(q) }
    }

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            content
        }
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .automatic),
                    prompt: "Search agents")
        .navigationTitle("Agents")
        .toolbarBackground(Theme.background, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar { ToolbarItem(placement: .navigationBarTrailing) { ProfileMenu() } }
        // Live running/connected dots: the projects fetch is a one-shot snapshot,
        // so the list's spinner lagged reality (or never appeared). Poll the cheap
        // agent-status endpoint every 5s while this tab is visible; the store only
        // publishes on real changes. .task cancels on tab switch automatically.
        .task {
            guard !store.isDemo else { return }
            while !Task.isCancelled {
                if let st = try? await appState.api.agentStatus() {
                    store.applyAgentStatus(st)
                }
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if store.loading && store.projects.isEmpty {
            MyMuLoader().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if store.agents.isEmpty {
            EmptyStateView(text: store.error ?? "No agents found.") { Task { await store.load(appState.api) } }
        } else if filtered.isEmpty {
            EmptyStateView(text: "No agents match “\(query)”.")
        } else {
            List(filtered) { agent in
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
