import SwiftUI

/// The MyMu brand loader — the "MyMu" wordmark with each letter fading in an
/// opacity wave (0.1 → 1 → 0.1) in sequence. Matches the web app's `.mymu-loader`
/// (1.6s period, 0.16s stagger). Shown while an agent is working.
struct MyMuLoader: View {
    var label: String? = nil
    private let letters = ["M", "y", "M", "u"]
    private let period = 1.6
    private let stagger = 0.16

    var body: some View {
        TimelineView(.animation) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            HStack(spacing: 8) {
                HStack(spacing: 1) {
                    ForEach(0..<letters.count, id: \.self) { i in
                        Text(letters[i])
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundColor(Theme.primary)
                            .opacity(opacity(t: t, index: i))
                    }
                }
                if let label {
                    Text(label).font(.caption).foregroundColor(Theme.mutedText)
                }
            }
        }
        .accessibilityLabel("Working")
    }

    /// Piecewise opacity mirroring the CSS keyframes: 0.1 at 0/0.6/1.0, peak at 0.25.
    private func opacity(t: Double, index: Int) -> Double {
        let delay = Double(index) * stagger
        var phase = ((t - delay).truncatingRemainder(dividingBy: period)) / period
        if phase < 0 { phase += 1 }
        let low = 0.1, high = 1.0
        if phase < 0.25 { return low + (high - low) * (phase / 0.25) }
        if phase < 0.60 { return high - (high - low) * ((phase - 0.25) / 0.35) }
        return low
    }
}
