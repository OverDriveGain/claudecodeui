import SwiftUI

struct RootView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        if appState.isAuthenticated {
            // Re-id on account switch: the whole tab tree (stores, relay
            // sockets) rebuilds against the newly-active server + token.
            MainTabView().id(appState.accountEpoch)
        } else if appState.isDemo {
            MainTabView(store: .demo())
        } else {
            LoginView()
        }
    }
}
