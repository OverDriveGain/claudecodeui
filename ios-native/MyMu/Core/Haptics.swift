import UIKit

/// ChatGPT-style tactile feedback: a light tap going out, a soft tap the moment
/// the agent starts answering, notification taps for permission asks, errors,
/// and turn completion. Generators are cheap to create per-call at this rate.
@MainActor
enum Haptics {
    static func send() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    static func firstResponse() { UIImpactFeedbackGenerator(style: .soft).impactOccurred() }
    static func complete() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    static func attention() { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
    static func error() { UINotificationFeedbackGenerator().notificationOccurred(.error) }
}
