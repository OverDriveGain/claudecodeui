import SwiftUI

/// Conversations tab — a flat, most-recent-first list of every session across
/// projects (MyMu's "Recents"). NavigationStack lives in MainTabView.
struct RecentsView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var store: ProjectsStore

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            content
        }
        .navigationTitle("Conversations")
        .toolbarBackground(Theme.background, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar { ToolbarItem(placement: .navigationBarTrailing) { ProfileMenu() } }
    }

    @ViewBuilder
    private var content: some View {
        if store.loading && store.projects.isEmpty {
            MyMuLoader().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if store.recents.isEmpty {
            EmptyStateView(text: "No conversations yet.") { Task { await store.load(appState.api) } }
        } else {
            List(store.recents) { item in
                NavigationLink(value: Route.chat(ChatTarget(
                    sessionId: item.session.id, projectId: item.project.projectId, isRemote: false,
                    title: item.session.displayTitle,
                    projectPath: item.project.fullPath ?? item.project.path))) {
                    row(item)
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

    private func row(_ item: RecentItem) -> some View {
        HStack(spacing: 12) {
            IconTile(symbol: "bubble.left.and.bubble.right", size: 34)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.session.displayTitle).foregroundColor(Theme.text).font(.body).lineLimit(1)
                Text(item.project.displayName).font(.caption2).foregroundColor(Theme.mutedText).lineLimit(1)
            }
            Spacer()
            Text(compactAge(item.session.sortKey)).font(.caption2).foregroundColor(Theme.mutedText)
        }
        .padding(.vertical, 4)
    }
}
