import SwiftUI

@main
struct MyMuApp: App {
    @StateObject private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            rootContent
                .environmentObject(appState)
                .preferredColorScheme(.dark)
                .tint(Theme.primary)
        }
    }

    @ViewBuilder
    private var rootContent: some View {
        #if DEBUG
        let demo = ProcessInfo.processInfo.environment["MYMU_DEMO"]
        if demo == "chat" {
            NavigationStack {
                ChatView(sessionId: "demo", projectId: "demo", isRemote: true,
                         title: "special-agent", token: "", previewMessages: DemoData.messages)
            }
        } else if demo == "tabs" {
            MainTabView(store: .demo())
        } else {
            RootView()
        }
        #else
        RootView()
        #endif
    }
}
