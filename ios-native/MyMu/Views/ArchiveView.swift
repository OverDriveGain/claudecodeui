import SwiftUI

/// Archived conversations, grouped-flat and most-recent-first. Read-only for now
/// (restore/delete are a follow-up). NavigationStack lives in MainTabView.
struct ArchiveView: View {
    @EnvironmentObject var appState: AppState
    @State private var archived: [Project] = []
    @State private var loading = true
    @State private var error: String?

    private var items: [RecentItem] {
        var out: [RecentItem] = []
        for p in archived {
            for s in (p.sessions ?? []) {
                out.append(RecentItem(id: "\(p.projectId)|\(s.id)", project: p, session: s))
            }
        }
        return out.sorted { $0.session.sortKey > $1.session.sortKey }
    }

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            content
        }
        .navigationTitle("Archive")
        .toolbarBackground(Theme.background, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .task { if archived.isEmpty { await load() } }
    }

    @ViewBuilder
    private var content: some View {
        if loading {
            MyMuLoader().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if items.isEmpty {
            EmptyStateView(text: error ?? "No archived conversations.")
        } else {
            List(items) { item in
                NavigationLink(value: Route.chat(ChatTarget(
                    sessionId: item.session.id, projectId: item.project.projectId, isRemote: false,
                    title: item.session.displayTitle,
                    projectPath: item.project.fullPath ?? item.project.path))) {
                    HStack(spacing: 12) {
                        IconTile(symbol: "archivebox", size: 34)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(item.session.displayTitle).foregroundColor(Theme.text).font(.body).lineLimit(1)
                            Text(item.project.displayName).font(.caption2).foregroundColor(Theme.mutedText).lineLimit(1)
                        }
                        Spacer()
                        Text(compactAge(item.session.sortKey)).font(.caption2).foregroundColor(Theme.mutedText)
                    }
                    .padding(.vertical, 4)
                }
                .listRowBackground(Color.clear)
                .listRowSeparatorTint(Theme.border)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .refreshable { await load() }
        }
    }

    private func load() async {
        error = nil
        do {
            archived = try await appState.api.archivedProjects()
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }
}
