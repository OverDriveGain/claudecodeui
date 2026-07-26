import SwiftUI

/// Live remote-control agents — the default tab. Non-expandable leaf rows with a
/// status dot, exactly like MyMu's Agents view. (NavigationStack + path live in
/// MainTabView so tab switches keep your place.)
struct AgentsView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var store: ProjectsStore
    @ObservedObject private var recents = RecentlyViewedStore.shared
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
            // Agent→host pinning map: loaded alongside the roster so opening a
            // pinned agent routes its conversation to the right host.
            await appState.refreshAgentHosts()
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
            List {
                if query.isEmpty && !recents.items.isEmpty {
                    Section {
                        lastSeenChips
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                            .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
                    }
                }
                ForEach(filtered) { agent in
                    NavigationLink(value: Route.chat(ChatTarget(
                        sessionId: agent.remoteSessionId ?? agent.projectId.replacingOccurrences(of: "remote:", with: ""),
                        projectId: agent.projectId, isRemote: true, title: agent.displayName))) {
                        row(agent)
                    }
                    .listRowBackground(Color.clear)
                    .listRowSeparatorTint(Theme.border)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .refreshable { await store.load(appState.api) }
        }
    }

    /// "Last seen" — the conversations the user most recently OPENED, as a small
    /// horizontal history strip. Remote entries re-resolve to the agent's CURRENT
    /// session (ids rotate on agent restarts).
    private var lastSeenChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(recents.items) { r in
                    NavigationLink(value: Route.chat(chipTarget(r))) {
                        HStack(spacing: 6) {
                            Image(systemName: r.isRemote ? "terminal" : "bubble.left")
                                .font(.caption2).foregroundColor(Theme.primary)
                            Text(r.title).font(.caption).foregroundColor(Theme.text)
                                .lineLimit(1).frame(maxWidth: 140)
                        }
                        .padding(.horizontal, 11).padding(.vertical, 7)
                        .background(Theme.surface)
                        .clipShape(Capsule())
                        .overlay(Capsule().stroke(Theme.border, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 6)
        }
    }

    private func chipTarget(_ r: RecentlyViewed) -> ChatTarget {
        if r.isRemote, let agent = store.agents.first(where: { $0.projectId == r.projectId }),
           let sid = agent.remoteSessionId {
            return ChatTarget(sessionId: sid, projectId: agent.projectId, isRemote: true, title: agent.displayName)
        }
        return ChatTarget(sessionId: r.sessionId, projectId: r.projectId, isRemote: r.isRemote,
                          title: r.title, projectPath: r.projectPath)
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
