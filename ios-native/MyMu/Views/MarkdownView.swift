import SwiftUI
import UIKit

/// Lightweight markdown renderer in the spirit of the Claude / ChatGPT apps:
/// fenced code blocks get a real monospace card (with copy + horizontal scroll),
/// everything else renders as inline markdown (bold/italic/inline-code/links/lists)
/// with whitespace preserved.
struct MarkdownView: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .code(let lang, let code):
                    CodeBlock(language: lang, code: code)
                case .text(let t):
                    inline(t)
                }
            }
        }
    }

    private func inline(_ s: String) -> some View {
        let opts = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        let attr = (try? AttributedString(markdown: s, options: opts)) ?? AttributedString(s)
        return Text(attr)
            .font(.system(size: 17))
            .lineSpacing(5)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var blocks: [MDBlock] { MarkdownView.parse(text) }

    static func parse(_ s: String) -> [MDBlock] {
        var result: [MDBlock] = []
        let lines = s.components(separatedBy: "\n")
        var buffer: [String] = []
        var i = 0

        func flush() {
            let t = buffer.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty { result.append(.text(t)) }
            buffer = []
        }

        while i < lines.count {
            let line = lines[i]
            if line.hasPrefix("```") {
                flush()
                let lang = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var code: [String] = []
                i += 1
                while i < lines.count && !lines[i].hasPrefix("```") {
                    code.append(lines[i]); i += 1
                }
                result.append(.code(lang.isEmpty ? nil : lang, code.joined(separator: "\n")))
                i += 1 // skip closing fence (if present)
            } else {
                buffer.append(line); i += 1
            }
        }
        flush()
        return result
    }
}

enum MDBlock {
    case text(String)
    case code(String?, String)
}

struct CodeBlock: View {
    let language: String?
    let code: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language ?? "code").font(.caption2).foregroundColor(Theme.mutedText)
                Spacer()
                Button {
                    UIPasteboard.general.string = code
                    copied = true
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(.caption2)
                        .foregroundColor(Theme.mutedText)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Color.white.opacity(0.03))

            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundColor(Theme.text)
                    .textSelection(.enabled)
                    .padding(10)
            }
        }
        .background(Color.black.opacity(0.35))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border, lineWidth: 1))
    }
}
