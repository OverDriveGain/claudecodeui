import SwiftUI
import UIKit

/// Renders one normalized chat message, Claude/ChatGPT-app style: assistant text
/// is full-width with real markdown; user text is a right-aligned bubble. Long-press
/// any message to copy.
struct MessageRow: View, Equatable {
    let message: ChatMessage
    let projectId: String
    let token: String
    /// Host override for routed conversations (delivered files stream from the
    /// agent's assigned host).
    var origin: String? = nil
    /// Visible action row (Copy) — only the newest assistant message gets one,
    /// like the Claude/ChatGPT apps; long-press covers every other message.
    var showActions = false

    /// Used with `.equatable()` so a streaming token only re-renders the ONE row
    /// whose message changed — re-rendering every visible row (each hosting a
    /// UITextView) per token made long chats crawl.
    static func == (l: MessageRow, r: MessageRow) -> Bool {
        l.message == r.message && l.showActions == r.showActions && l.projectId == r.projectId
    }

    var body: some View {
        // Text messages get NO row-level context menu: long-press there belongs to
        // the UITextView word/sentence selection (SelectableText); a contextMenu
        // would swallow the gesture. Other kinds keep long-press → Copy.
        if message.kind == "text" {
            content
        } else {
            content
                .contextMenu {
                    if !copyText.isEmpty {
                        Button {
                            UIPasteboard.general.string = copyText
                        } label: { Label("Copy", systemImage: "doc.on.doc") }
                    }
                }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch message.kind {
        case "text":
            textBody
        case "tool_use":
            if let d = deliveredFiles { mediaDelivery(d.files, d.caption) } else { toolUse }
        case "tool_result":
            toolResult
        case "error":
            errorRow
        default:
            EmptyView()
        }
    }

    private var isUser: Bool { message.role == "user" }
    /// Body with trailing blank lines removed — `.inlineOnlyPreservingWhitespace`
    /// faithfully renders them, which reads as empty space under the message.
    private var trimmedBody: String {
        message.bodyText.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private var copyText: String {
        trimmedBody.isEmpty ? (message.content ?? "") : trimmedBody
    }

    // MARK: text

    @ViewBuilder
    private var textBody: some View {
        if message.isInjected == true {
            // Harness-injected context (skill payloads etc.) rides in as a
            // user-role row — but the person never typed it. A right-side bubble
            // reads as "I sent this", so it renders as a dimmed, collapsed chip
            // on the agent side instead (matching the web client).
            InjectedContextChip(body: trimmedBody)
        } else if isUser {
            HStack {
                Spacer(minLength: 32)
                VStack(alignment: .trailing, spacing: 6) {
                    if let images = message.images, !images.isEmpty {
                        ForEach(images, id: \.self) { url in
                            DataURLImage(dataURL: url)
                                .frame(maxWidth: 260, maxHeight: 260, alignment: .trailing)
                                .clipShape(RoundedRectangle(cornerRadius: 16))
                        }
                    }
                    if !trimmedBody.isEmpty {
                        MarkdownView(text: trimmedBody)
                            .foregroundColor(Theme.text)
                            .frame(maxWidth: 310, alignment: .leading)
                            .padding(.horizontal, 15)
                            .padding(.vertical, 11)
                            .background(Theme.userBubble)
                            .clipShape(RoundedRectangle(cornerRadius: 20))
                    }
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                MarkdownView(text: trimmedBody)
                    .foregroundColor(Theme.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if showActions {
                    CopyButton(text: copyText)
                }
            }
        }
    }

    // MARK: tools

    private var toolUse: some View {
        HStack(spacing: 6) {
            Image(systemName: icon(for: message.toolName)).font(.caption2)
            Text(message.toolName ?? "tool").font(.caption)
        }
        .foregroundColor(Theme.mutedText)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(Theme.surface)
        .clipShape(Capsule())
        .overlay(Capsule().stroke(Theme.border, lineWidth: 1))
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var toolResult: some View {
        if let c = message.content, !c.isEmpty {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "arrow.turn.down.right").font(.caption2).foregroundColor(Theme.mutedText.opacity(0.7))
                // Only ~10 lines ever show, but Text LAYS OUT the whole string —
                // a runaway tool result (100s of KB, e.g. embedded base64) froze
                // the chat for seconds per frame. Cap what reaches layout.
                Text(c.count > 4000 ? String(c.prefix(4000)) + "…" : c)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundColor(message.isError == true ? Theme.danger : Theme.mutedText)
                    .lineLimit(10)
                    .textSelection(.enabled)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 2)
            .padding(.vertical, 2)
        }
    }

    private var errorRow: some View {
        Text(message.content ?? "Error")
            .foregroundColor(Theme.danger)
            .font(.callout)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(Theme.danger.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: delivered media (SendUserFile)

    private var deliveredFiles: (files: [String], caption: String?)? {
        guard message.kind == "tool_use", message.toolName == "SendUserFile",
              let dict = message.toolInput?.value as? [String: Any] else { return nil }
        let files = (dict["files"] as? [Any])?.compactMap { $0 as? String } ?? []
        guard !files.isEmpty else { return nil }
        return (files, dict["caption"] as? String)
    }

    private func mediaDelivery(_ files: [String], _ caption: String?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let caption, !caption.isEmpty {
                Text(caption).font(.caption).foregroundColor(Theme.mutedText)
            }
            ForEach(files, id: \.self) { f in
                DeliveredMediaView(path: f, projectId: projectId, token: token, origin: origin)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: helpers

    static func injectedLabel(for body: String) -> String {
        // First markdown heading if there is one, else the first line, clipped.
        let heading = body
            .split(separator: "\n", omittingEmptySubsequences: true)
            .first { $0.hasPrefix("#") }?
            .drop { $0 == "#" || $0 == " " }
        let source = heading.map(String.init)
            ?? String(body.drop { $0.isWhitespace }.prefix { !$0.isNewline })
        let trimmed = source.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return "Injected instructions" }
        return trimmed.count > 56 ? String(trimmed.prefix(56)).trimmingCharacters(in: .whitespaces) + "…" : trimmed
    }

    private func icon(for tool: String?) -> String {
        switch tool ?? "" {
        case "Read": return "doc.text"
        case "Write", "Edit", "MultiEdit": return "pencil"
        case "Bash": return "terminal"
        case "Grep", "Glob": return "magnifyingglass"
        case "WebFetch", "WebSearch": return "globe"
        case "Task": return "person.2"
        case "TodoWrite": return "checklist"
        case "SendUserFile": return "paperclip"
        default: return "wrench.and.screwdriver"
        }
    }
}

/// Collapsed "Context added automatically" chip for harness-injected content.
/// Tap to expand the full payload; long-press the expanded text to copy.
private struct InjectedContextChip: View {
    let body_: String
    @State private var expanded = false

    init(body: String) { self.body_ = body }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.caption2.weight(.semibold))
                    Image(systemName: "gearshape")
                        .font(.caption2)
                    Text("Context · \(MessageRow.injectedLabel(for: body_))")
                        .font(.caption)
                        .lineLimit(1)
                }
                .foregroundColor(Theme.mutedText)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(Theme.surface)
                .clipShape(Capsule())
                .overlay(Capsule().stroke(Theme.border, lineWidth: 1))
            }
            if expanded {
                ScrollView {
                    Text(body_)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundColor(Theme.mutedText)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10)
                }
                .frame(maxHeight: 260)
                .background(Theme.surface)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border, lineWidth: 1))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
