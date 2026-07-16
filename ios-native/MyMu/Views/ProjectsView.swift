import SwiftUI

/// Projects = folders. Each opens to its conversations. (NavigationStack lives
/// in MainTabView.)
struct ProjectsView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var store: ProjectsStore

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            content
        }
        .navigationTitle("Projects")
        .toolbarBackground(Theme.background, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar { ToolbarItem(placement: .navigationBarTrailing) { ProfileMenu() } }
    }

    @ViewBuilder
    private var content: some View {
        if store.loading && store.projects.isEmpty {
            MyMuLoader().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if store.folders.isEmpty {
            EmptyStateView(text: store.error ?? "No projects yet.") { Task { await store.load(appState.api) } }
        } else {
            List(store.folders) { p in
                NavigationLink(value: Route.projectDetail(p)) { row(p) }
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
            IconTile(symbol: "folder")
            VStack(alignment: .leading, spacing: 3) {
                Text(p.displayName).foregroundColor(Theme.text).font(.body).lineLimit(1)
                let count = p.sessions?.count ?? 0
                Text("\(count) conversation\(count == 1 ? "" : "s")")
                    .font(.caption2).foregroundColor(Theme.mutedText)
            }
            Spacer()
        }
        .padding(.vertical, 4)
    }
}
