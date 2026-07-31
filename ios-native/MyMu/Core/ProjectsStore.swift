import SwiftUI

/// One shared fetch of `/api/projects`, consumed by the Agents, Chats and
/// Projects tabs so they stay in sync and don't each hit the network.
@MainActor
final class ProjectsStore: ObservableObject {
    @Published var projects: [Project] = []
    @Published var loading = true
    @Published var error: String?
    var isDemo = false
    private var loaded = false

    func loadIfNeeded(_ api: APIClient) async {
        if isDemo || loaded { return }
        await load(api)
    }

    /// Pre-seeded store for the DEBUG demo/screenshot screens.
    static func demo() -> ProjectsStore {
        let s = ProjectsStore()
        s.isDemo = true
        s.loading = false
        s.projects = DemoData.projects
        return s
    }

    func load(_ api: APIClient) async {
        error = nil
        do {
            projects = try await api.projects()
            loaded = true
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }

    /// Merge live agent running/connected flags into the loaded projects. Only
    /// publishes when something actually changed, so the 5s poll doesn't cause
    /// pointless list re-renders.
    func applyAgentStatus(_ statuses: [APIClient.AgentStatusEntry]) {
        guard !statuses.isEmpty else { return }
        let byId = Dictionary(uniqueKeysWithValues: statuses.map { ($0.id, $0) })
        var changed = false
        var next = projects
        for i in next.indices where next[i].isRemoteAgent == true {
            guard let sid = next[i].remoteSessionId, let st = byId[sid] else { continue }
            if next[i].remoteRunning != st.running || next[i].remoteConnected != st.connected {
                next[i].remoteRunning = st.running
                next[i].remoteConnected = st.connected
                changed = true
            }
        }
        if changed { projects = next }
    }

    var agents: [Project] { projects.filter { $0.isRemoteAgent == true } }
    var folders: [Project] { projects.filter { $0.isRemoteAgent != true } }

    /// Flat, recency-sorted sessions across all local projects — the "Chats" tab.
    var recents: [RecentItem] {
        var items: [RecentItem] = []
        for p in folders {
            for s in (p.sessions ?? []) {
                items.append(RecentItem(id: "\(p.projectId)|\(s.id)", project: p, session: s))
            }
        }
        return items.sorted { $0.session.sortKey > $1.session.sortKey }
    }
}

struct RecentItem: Identifiable {
    let id: String
    let project: Project
    let session: Session
}
