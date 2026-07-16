import SwiftUI

/// MyMu brand palette (the app's dark identity — mirrors src/index.css dark theme).
enum Theme {
    static let background = Color(hex: "222222")   // conversation bg (darkest)
    static let surface = Color(hex: "2B2B2B")      // cards / composer (elevated)
    static let elevated = Color(hex: "393939")     // hover / selected / border
    static let primary = Color(hex: "AA88DD")      // brand accent — "the M"
    static let text = Color(hex: "E0E0E0")         // default text
    static let mutedText = Color(hex: "8C8C8C")    // secondary text
    static let border = Color(hex: "393939")
    static let danger = Color(hex: "DB5C5C")       // error red
    static let userBubble = Color(hex: "AA88DD").opacity(0.20)
    static let assistantBubble = Color(hex: "2B2B2B")
}

extension Color {
    init(hex: String) {
        let s = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var v: UInt64 = 0
        Scanner(string: s).scanHexInt64(&v)
        let r, g, b, a: Double
        switch s.count {
        case 8:
            r = Double((v & 0xFF00_0000) >> 24) / 255
            g = Double((v & 0x00FF_0000) >> 16) / 255
            b = Double((v & 0x0000_FF00) >> 8) / 255
            a = Double(v & 0x0000_00FF) / 255
        default: // 6
            r = Double((v & 0xFF0000) >> 16) / 255
            g = Double((v & 0x00FF00) >> 8) / 255
            b = Double(v & 0x0000FF) / 255
            a = 1
        }
        self.init(.sRGB, red: r, green: g, blue: b, opacity: a)
    }
}
