import SwiftUI

/// One conversation the user actually OPENED. A local "last seen" history
/// (device-side, UserDefaults), distinct from the Chats tab which sorts by
/// server-side activity.
struct RecentlyViewed: Codable, Identifiable, Equatable {
    let sessionId: String
    let projectId: String
    let title: String
    var projectPath: String?
    var at: Date
    var id: String { sessionId.isEmpty ? projectId : sessionId }
}

@MainActor
final class RecentlyViewedStore: ObservableObject {
    static let shared = RecentlyViewedStore()

    @Published private(set) var items: [RecentlyViewed] = []
    private let key = "recentlyViewedConversations"
    private let cap = 10

    init() {
        if let data = UserDefaults.standard.data(forKey: key),
           let arr = try? JSONDecoder().decode([RecentlyViewed].self, from: data) {
            items = arr
        }
    }

    /// Record an open, deduped by session id (newest first).
    func record(sessionId: String, projectId: String, title: String, projectPath: String? = nil) {
        guard !sessionId.isEmpty || !projectId.isEmpty else { return }
        var next = items.filter { $0.sessionId != sessionId }
        next.insert(RecentlyViewed(sessionId: sessionId, projectId: projectId,
                                   title: title, projectPath: projectPath, at: Date()), at: 0)
        if next.count > cap { next = Array(next.prefix(cap)) }
        items = next
        if let data = try? JSONEncoder().encode(items) { UserDefaults.standard.set(data, forKey: key) }
    }
}
