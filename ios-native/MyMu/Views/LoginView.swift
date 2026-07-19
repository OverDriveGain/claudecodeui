import SwiftUI

struct LoginView: View {
    @EnvironmentObject var appState: AppState
    @State private var serverOrigin = Config.serverOrigin
    @State private var username = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            ScrollView {
                VStack(spacing: 22) {
                    brandHeader
                        .padding(.top, 60)
                    VStack(spacing: 12) {
                        field("Server", text: $serverOrigin, icon: "server.rack", keyboard: .URL)
                        field("Username", text: $username, icon: "person")
                        secureField("Password", text: $password, icon: "lock")
                    }
                    if let error {
                        Text(error).foregroundColor(Theme.danger).font(.footnote)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    signInButton
                    Spacer(minLength: 40)
                }
                .padding(24)
            }
        }
    }

    private var brandHeader: some View {
        VStack(spacing: 8) {
            Text("MyMu")
                .font(.system(size: 44, weight: .semibold))
                .foregroundColor(Theme.primary)
            Text("Drive your agents")
                .font(.subheadline)
                .foregroundColor(Theme.mutedText)
        }
    }

    private func field(_ placeholder: String, text: Binding<String>, icon: String, keyboard: UIKeyboardType = .default) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon).foregroundColor(Theme.mutedText).frame(width: 20)
            TextField("", text: text, prompt: Text(placeholder).foregroundColor(Theme.mutedText))
                .foregroundColor(Theme.text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(keyboard)
        }
        .padding(14)
        .background(Theme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border, lineWidth: 1))
    }

    private func secureField(_ placeholder: String, text: Binding<String>, icon: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon).foregroundColor(Theme.mutedText).frame(width: 20)
            SecureField("", text: text, prompt: Text(placeholder).foregroundColor(Theme.mutedText))
                .foregroundColor(Theme.text)
        }
        .padding(14)
        .background(Theme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border, lineWidth: 1))
    }

    private var signInButton: some View {
        Button {
            Task { await doLogin() }
        } label: {
            HStack {
                if busy { ProgressView().tint(Theme.background) }
                Text(busy ? "Signing in…" : "Sign in").fontWeight(.semibold)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(Theme.primary)
            .foregroundColor(Theme.background)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .opacity(canSubmit ? 1 : 0.5)
        }
        .disabled(!canSubmit)
    }

    private var canSubmit: Bool { !busy && !username.isEmpty && !password.isEmpty }

    private func doLogin() async {
        error = nil
        busy = true
        Config.serverOrigin = serverOrigin
        do {
            try await appState.login(username: username, password: password)
        } catch {
            self.error = error.localizedDescription
        }
        busy = false
    }
}
