import SwiftUI
import AVKit

/// Inline preview of a file an agent delivered (SendUserFile). Streams from the
/// authenticated delivered-file endpoint (token in the query — media elements
/// can't set headers). Range is supported server-side so video/audio seek.
struct DeliveredMediaView: View {
    let path: String
    let projectId: String
    let token: String

    private var url: URL? {
        Config.fileStreamURL(projectId: projectId, path: path, token: token, delivered: true)
    }
    private var ext: String { (path as NSString).pathExtension.lowercased() }
    private var name: String { (path as NSString).lastPathComponent }

    var body: some View {
        if let url {
            switch ext {
            case "png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "avif":
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let img):
                        img.resizable().scaledToFit()
                    case .failure:
                        fallback(url)
                    case .empty:
                        ProgressView().frame(maxWidth: .infinity, minHeight: 120)
                    @unknown default:
                        fallback(url)
                    }
                }
                .frame(maxHeight: 320)
                .clipShape(RoundedRectangle(cornerRadius: 12))
            case "mp4", "mov", "m4v", "webm", "ogv":
                VideoBubble(url: url)
            case "mp3", "wav", "m4a", "aac", "ogg", "opus", "flac", "oga":
                AudioBubble(url: url, name: name)
            default:
                fallback(url)
            }
        }
    }

    private func fallback(_ url: URL) -> some View {
        Link(destination: url) {
            Label(name, systemImage: "doc")
                .font(.caption)
                .foregroundColor(Theme.primary)
        }
    }
}

/// Holds its AVPlayer in state so body re-evaluations don't reset playback.
struct VideoBubble: View {
    let url: URL
    @State private var player: AVPlayer?

    var body: some View {
        Group {
            if let player {
                VideoPlayer(player: player)
            } else {
                Color.black
            }
        }
        .frame(height: 220)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .onAppear { if player == nil { player = AVPlayer(url: url) } }
        .onDisappear { player?.pause() }
    }
}

struct AudioBubble: View {
    let url: URL
    let name: String
    @State private var player: AVPlayer?
    @State private var playing = false

    var body: some View {
        HStack(spacing: 10) {
            Button {
                guard let player else { return }
                if playing { player.pause() } else { player.play() }
                playing.toggle()
            } label: {
                Image(systemName: playing ? "pause.circle.fill" : "play.circle.fill")
                    .font(.title)
                    .foregroundColor(Theme.primary)
            }
            Text(name).font(.caption).foregroundColor(Theme.text).lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(Theme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .onAppear { if player == nil { player = AVPlayer(url: url) } }
        .onDisappear { player?.pause(); playing = false }
    }
}
