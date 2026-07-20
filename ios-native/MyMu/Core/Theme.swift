import SwiftUI

/// MyMu brand palette — pitch-black, high-contrast. The purple IS the identity
/// and stays untouched; everything that was a washed mid-gray got pushed to
/// true black (OLED-crisp) with brighter text so edges read sharp, not pale.
enum Theme {
    static let background = Color(hex: "000000")   // conversation bg — pitch black
    static let surface = Color(hex: "111113")      // cards / composer (barely lifted)
    static let elevated = Color(hex: "232328")     // hover / selected
    static let primary = Color(hex: "AA88DD")      // brand accent — "the M" (unchanged)
    static let text = Color(hex: "F2F2F7")         // crisp near-white
    static let mutedText = Color(hex: "A3A3AC")    // secondary — readable on black
    static let border = Color(hex: "232328")
    static let danger = Color(hex: "E5484D")       // sharper error red
    static let userBubble = Color(hex: "AA88DD").opacity(0.22)
    static let assistantBubble = Color(hex: "141416")
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
