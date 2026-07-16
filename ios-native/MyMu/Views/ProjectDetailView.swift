import SwiftUI

/// A project's conversations (sessions), most-recent-first, with a "new
/// conversation" action (starts a fresh session in this project's directory).
struct ProjectDetailView: View {
    let project: Project
    @EnvironmentObject var appState: AppState

    private var sessions: [Session] {
        (project.sessions ?? []).sorted { $0.sortKey > $1.sortKey }
    }

    private var newChatTarget: ChatTarget {
        ChatTarget(sessionId: "", projectId: project.projectId, isRemote: false,
                   title: project.displayName, projectPath: project.fullPath ?? project.path)
    }

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            if sessions.isEmpty {
                VStack(spacing: 14) {
                    Text("No conversations yet.").foregroundColor(Theme.mutedText)
                    NavigationLink(value: Route.chat(newChatTarget)) {
                        Label("New conversation", systemImage: "square.and.pencil")
                            .foregroundColor(Theme.primary)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(sessions) { s in
                    NavigationLink(value: Route.chat(ChatTarget(
                        sessionId: s.id, projectId: project.projectId, isRemote: false,
                        title: s.displayTitle, projectPath: project.fullPath ?? project.path))) {
                        row(s)
                    }
                    .listRowBackground(Color.clear)
                    .listRowSeparatorTint(Theme.border)
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .background(Theme.background)
            }
        }
        .navigationTitle(project.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.background, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                NavigationLink(value: Route.chat(newChatTarget)) {
                    Image(systemName: "square.and.pencil").foregroundColor(Theme.primary)
                }
            }
        }
    }

    private func row(_ s: Session) -> some View {
        HStack(spacing: 12) {
            IconTile(symbol: "bubble.left.and.bubble.right", size: 34)
            VStack(alignment: .leading, spacing: 3) {
                Text(s.displayTitle).foregroundColor(Theme.text).font(.body).lineLimit(1)
                HStack(spacing: 6) {
                    if let c = s.messageCount { Text("\(c) messages").font(.caption2).foregroundColor(Theme.mutedText) }
                    Text(compactAge(s.sortKey)).font(.caption2).foregroundColor(Theme.mutedText)
                }
            }
            Spacer()
        }
        .padding(.vertical, 4)
    }
}
