import SwiftUI
import AVKit
import ImageIO
import UIKit

/// AsyncImage replacement for authenticated media. AsyncImage cancels its load
/// the moment the row leaves the viewport — the open-settle scroll does that
/// constantly in a lazy transcript — and then PARKS in .failure forever, so
/// images showed as bare filename chips. This loader retries on every
/// re-appear, keeps decoded images in a process-wide cache (scroll-back is
/// instant, no re-download), and downsamples huge renders to screen scale.
struct RemoteImage<Failure: View>: View {
    let url: URL
    var zoomable = false
    @ViewBuilder let failure: () -> Failure

    @State private var image: UIImage?
    @State private var failed = false
    @State private var attempt = 0
    @State private var lightbox = false

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFit()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .onTapGesture { if zoomable { lightbox = true } }
                    .fullScreenCover(isPresented: $lightbox) { ImageLightbox(image: image) }
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

    /// Full-resolution renders (multi-MB, 3000px+) get decoded at a bounded
    /// pixel size so a view with several images can't spike memory.
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
    var zoomable = false

    @State private var image: UIImage?
    @State private var failed = false
    @State private var lightbox = false

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFit()
                    .onTapGesture { if zoomable { lightbox = true } }
                    .fullScreenCover(isPresented: $lightbox) { ImageLightbox(image: image) }
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

/// Full-screen viewer for a tapped inline image: pinch to zoom (1–6x),
/// double-tap to toggle, pan while zoomed, X or tap-at-1x to close.
struct ImageLightbox: View {
    let image: UIImage
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            ZoomableImage(image: image) { dismiss() }
                .ignoresSafeArea()
            Button { dismiss() } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(.white.opacity(0.85), .black.opacity(0.5))
                    .padding(14)
            }
        }
        .statusBarHidden()
    }
}

/// UIScrollView-backed zoom — SwiftUI has no native pinch-zoomable scroll view.
private struct ZoomableImage: UIViewRepresentable {
    let image: UIImage
    let onTapAtMinZoom: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onTapAtMinZoom: onTapAtMinZoom) }

    func makeUIView(context: Context) -> UIScrollView {
        let scroll = UIScrollView()
        scroll.minimumZoomScale = 1
        scroll.maximumZoomScale = 6
        scroll.showsVerticalScrollIndicator = false
        scroll.showsHorizontalScrollIndicator = false
        scroll.backgroundColor = .clear
        scroll.contentInsetAdjustmentBehavior = .never
        scroll.delegate = context.coordinator

        let iv = UIImageView(image: image)
        iv.contentMode = .scaleAspectFit
        iv.frame = scroll.bounds
        iv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        iv.isUserInteractionEnabled = true
        scroll.addSubview(iv)
        context.coordinator.imageView = iv

        let doubleTap = UITapGestureRecognizer(target: context.coordinator,
                                               action: #selector(Coordinator.doubleTapped(_:)))
        doubleTap.numberOfTapsRequired = 2
        iv.addGestureRecognizer(doubleTap)
        let tap = UITapGestureRecognizer(target: context.coordinator,
                                         action: #selector(Coordinator.singleTapped(_:)))
        tap.require(toFail: doubleTap)
        iv.addGestureRecognizer(tap)
        return scroll
    }

    func updateUIView(_ scroll: UIScrollView, context: Context) {
        // Frame arrives after makeUIView; keep the image view filling at 1x.
        if scroll.zoomScale == 1 { context.coordinator.imageView?.frame = scroll.bounds }
    }

    final class Coordinator: NSObject, UIScrollViewDelegate {
        var imageView: UIImageView?
        let onTapAtMinZoom: () -> Void
        init(onTapAtMinZoom: @escaping () -> Void) { self.onTapAtMinZoom = onTapAtMinZoom }

        func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

        // Keep the (aspect-fit) content centered while zoomed.
        func scrollViewDidZoom(_ s: UIScrollView) {
            let dx = max((s.bounds.width - s.contentSize.width) / 2, 0)
            let dy = max((s.bounds.height - s.contentSize.height) / 2, 0)
            s.contentInset = UIEdgeInsets(top: dy, left: dx, bottom: dy, right: dx)
        }

        @objc func doubleTapped(_ g: UITapGestureRecognizer) {
            guard let scroll = imageView?.superview as? UIScrollView else { return }
            if scroll.zoomScale > 1 {
                scroll.setZoomScale(1, animated: true)
            } else {
                let point = g.location(in: imageView)
                let size = CGSize(width: scroll.bounds.width / 3, height: scroll.bounds.height / 3)
                let rect = CGRect(origin: CGPoint(x: point.x - size.width / 2,
                                                  y: point.y - size.height / 2), size: size)
                scroll.zoom(to: rect, animated: true)
            }
        }

        @objc func singleTapped(_ g: UITapGestureRecognizer) {
            guard let scroll = imageView?.superview as? UIScrollView else { return }
            if scroll.zoomScale <= 1.01 { onTapAtMinZoom() }
        }
    }
}
