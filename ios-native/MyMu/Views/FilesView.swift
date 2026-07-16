import SwiftUI

/// The agent/project file tree (its working directory). Loads the whole nested
/// tree in one call; directories drill down, files open a preview. For a
/// cross-host relay agent the server has no filesystem channel, so this shows a
/// friendly note instead of an error.
struct FilesView: View {
    let projectId: String
    let token: String
    let title: String

    @State private var nodes: [FileNode] = []
    @State private var loading = true
    @State private var error: String?

    var body: some View {
        Group {
            if loading {
                MyMuLoader().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error {
                EmptyStateView(text: error)
            } else if nodes.isEmpty {
                EmptyStateView(text: "No files.")
            } else {
                FileBrowser(title: "Files", nodes: nodes, projectId: projectId, token: token)
            }
        }
        .background(Theme.background)
        .navigationTitle("Files")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.background, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .task { await load() }
    }

    private func load() async {
        do {
            let tree = try await APIClient(token: token).files(projectId: projectId)
            nodes = tree.sorted {
                if $0.isDir != $1.isDir { return $0.isDir && !$1.isDir }
                return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
            }
        } catch APIError.http(let code, _) where code == 404 || code == 502 {
            error = "Files aren’t available for this agent — it may be running on another host."
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }
}

/// One level of the tree. Recurses via NavigationLink into subdirectories.
struct FileBrowser: View {
    let title: String
    let nodes: [FileNode]
    let projectId: String
    let token: String

    var body: some View {
        List(nodes) { node in
            row(node)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.background, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
    }

    @ViewBuilder
    private func row(_ node: FileNode) -> some View {
        if node.isDir {
            NavigationLink {
                FileBrowser(title: node.name, nodes: node.sortedChildren, projectId: projectId, token: token)
            } label: { label(node) }
        } else {
            NavigationLink {
                FilePreviewView(name: node.name, path: node.path, projectId: projectId, token: token)
            } label: { label(node) }
        }
    }

    private func label(_ n: FileNode) -> some View {
        HStack(spacing: 10) {
            Image(systemName: n.isDir ? "folder.fill" : fileIcon(n.name))
                .foregroundColor(n.isDir ? Theme.primary : Theme.mutedText)
                .frame(width: 22)
            Text(n.name).foregroundColor(Theme.text).font(.body).lineLimit(1)
            Spacer()
            if n.isDir { Image(systemName: "chevron.right").font(.caption2).foregroundColor(Theme.mutedText) }
        }
        .padding(.vertical, 2)
    }
}

/// Text preview (monospace) or inline media for a single file.
struct FilePreviewView: View {
    let name: String
    let path: String
    let projectId: String
    let token: String

    @State private var text: String?
    @State private var loading = true
    @State private var error: String?

    private var ext: String { (name as NSString).pathExtension.lowercased() }
    private var isImage: Bool { ["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp"].contains(ext) }
    private var isVideo: Bool { ["mp4", "mov", "m4v"].contains(ext) }
    private var isAudio: Bool { ["mp3", "wav", "m4a", "aac", "flac"].contains(ext) }
    private var isMedia: Bool { isImage || isVideo || isAudio }

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            ScrollView {
                if isMedia {
                    media.padding()
                } else if loading {
                    MyMuLoader().padding(.top, 40)
                } else if let error {
                    Text(error).foregroundColor(Theme.danger).padding()
                } else if let text {
                    Text(text)
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundColor(Theme.text)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding()
                }
            }
        }
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.background, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .task { if isMedia { loading = false } else { await load() } }
    }

    @ViewBuilder
    private var media: some View {
        if let url = Config.fileStreamURL(projectId: projectId, path: path, token: token, delivered: false) {
            if isImage {
                AsyncImage(url: url) { $0.resizable().scaledToFit() } placeholder: { ProgressView() }
                    .clipShape(RoundedRectangle(cornerRadius: 10))
            } else if isVideo {
                VideoBubble(url: url)
            } else {
                AudioBubble(url: url, name: name)
            }
        }
    }

    private func load() async {
        do {
            text = try await APIClient(token: token).fileText(projectId: projectId, filePath: path)
        } catch {
            self.error = "Can’t preview this file."
        }
        loading = false
    }
}

func fileIcon(_ name: String) -> String {
    switch (name as NSString).pathExtension.lowercased() {
    case "swift", "js", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "c", "cpp", "h": return "curlybraces"
    case "json", "yml", "yaml", "toml": return "curlybraces.square"
    case "md", "txt", "rtf": return "doc.text"
    case "png", "jpg", "jpeg", "gif", "webp", "heic", "bmp": return "photo"
    case "mp4", "mov", "m4v": return "film"
    case "mp3", "wav", "m4a", "aac", "flac": return "waveform"
    case "pdf": return "doc.richtext"
    case "sh", "bash", "zsh": return "terminal"
    default: return "doc"
    }
}
