import SwiftUI
import AVKit
import ImageIO
import UIKit

/// AsyncImage replacement for authenticated media. AsyncImage cancels its load
/// the moment the row leaves the viewport — the open-settle scroll does that
/// constantly in a lazy transcript — and then PARKS in .failure forever, so
/// delivered images showed as bare filename chips. This loader retries on every
/// re-appear, keeps decoded images in a process-wide cache (scroll-back is
/// instant, no re-download), and downsamples huge renders to screen scale.
struct RemoteImage<Failure: View>: View {
    let url: URL
    @ViewBuilder let failure: () -> Failure

    @State private var image: UIImage?
    @State private var failed = false
    @State private var attempt = 0

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFit()
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if failed {
                failure()
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        // .task re-runs when the row re-enters the viewport; bumping `attempt`
        // on re-appear also retries a genuine earlier failure.
        .task(id: attempt) { await load() }
        .onAppear { if image == nil && failed { failed = false; attempt += 1 } }
    }

    private func load() async {
        if let cached = RemoteImageCache.shared.object(forKey: url as NSURL) { image = cached; return }
        do {
            let (data, resp) = try await URLSession.shared.data(from: url)
            guard (resp as? HTTPURLResponse)?.statusCode == 200, let img = Self.downsampled(data) else {
                failed = true
                return
            }
            RemoteImageCache.shared.setObject(img, forKey: url as NSURL)
            image = img
        } catch {
            // A cancelled load (row left the screen mid-download) is not a
            // failure — the next appear retries it silently.
            if (error as? URLError)?.code == .cancelled || error is CancellationError { return }
            failed = true
        }
    }

    /// Agents deliver full-resolution renders (multi-MB, 3000px+). Decode at a
    /// bounded pixel size so a transcript with several images can't spike memory.
    private static func downsampled(_ data: Data) -> UIImage? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return UIImage(data: data) }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: 1600,
            kCGImageSourceCreateThumbnailWithTransform: true,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else {
            return UIImage(data: data)
        }
        return UIImage(cgImage: cg)
    }
}

enum RemoteImageCache {
    static let shared: NSCache<NSURL, UIImage> = {
        let c = NSCache<NSURL, UIImage>()
        c.totalCostLimit = 64 * 1024 * 1024
        return c
    }()
}

/// Renders an inline image from a `data:image/...;base64,...` URL — used for
/// photos the user attached to their own message (decoded once, off the main
/// thread, and downsampled so a full-res photo can't spike memory).
struct DataURLImage: View {
    let dataURL: String

    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFit()
            } else if failed {
                Image(systemName: "photo").foregroundColor(Theme.mutedText)
            } else {
                ProgressView()
            }
        }
        .task { await decode() }
    }

    private func decode() async {
        guard image == nil else { return }
        let src = dataURL
        let decoded: UIImage? = await Task.detached(priority: .userInitiated) {
            guard let comma = src.firstIndex(of: ","), src.hasPrefix("data:"),
                  let data = Data(base64Encoded: String(src[src.index(after: comma)...])) else { return nil }
            return downsampledImage(data)
        }.value
        if let decoded { image = decoded } else { failed = true }
    }
}

/// Decode `data` at a bounded pixel size (shared by RemoteImage-style loaders).
func downsampledImage(_ data: Data, maxPixel: Int = 1600) -> UIImage? {
    guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return UIImage(data: data) }
    let opts: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        kCGImageSourceCreateThumbnailWithTransform: true,
    ]
    guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else {
        return UIImage(data: data)
    }
    return UIImage(cgImage: cg)
}

/// Inline preview of a file an agent delivered (SendUserFile). Streams from the
/// authenticated delivered-file endpoint (token in the query — media elements
/// can't set headers). Range is supported server-side so video/audio seek.
struct DeliveredMediaView: View {
    let path: String
    let projectId: String
    let token: String
    var origin: String? = nil

    private var url: URL? {
        Config.fileStreamURL(projectId: projectId, path: path, token: token, delivered: true, origin: origin)
    }
    private var ext: String { (path as NSString).pathExtension.lowercased() }
    private var name: String { (path as NSString).lastPathComponent }

    var body: some View {
        if let url {
            switch ext {
            case "png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "avif":
                // CONSTANT height, placeholder and loaded alike. The old
                // placeholder (120pt) grew to the loaded size (≤320pt) seconds
                // after the transcript pinned its bottom — every image load
                // reflowed the list and re-opened the blank strip when opening
                // an agent conversation. A row's height must NEVER change after
                // first layout.
                RemoteImage(url: url) { fallback(url) }
                    .frame(height: 240, alignment: .leading)
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
