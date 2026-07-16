import SwiftUI
import UIKit

/// Renders one normalized chat message, Claude/ChatGPT-app style: assistant text
/// is full-width with real markdown; user text is a right-aligned bubble. Long-press
/// any message to copy.
struct MessageRow: View {
    let message: ChatMessage
    let projectId: String
    let token: String
    /// Visible action row (Copy) — only the newest assistant message gets one,
    /// like the Claude/ChatGPT apps; long-press covers every other message.
    var showActions = false

    var body: some View {
        content
            .contextMenu {
                if !copyText.isEmpty {
                    Button {
                        UIPasteboard.general.string = copyText
                    } label: { Label("Copy", systemImage: "doc.on.doc") }
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
        if isUser {
            HStack {
                Spacer(minLength: 32)
                MarkdownView(text: trimmedBody)
                    .foregroundColor(Theme.text)
                    .frame(maxWidth: 310, alignment: .leading)
                    .padding(.horizontal, 15)
                    .padding(.vertical, 11)
                    .background(Theme.userBubble)
                    .clipShape(RoundedRectangle(cornerRadius: 20))
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
                Text(c)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundColor(message.isError == true ? Theme.danger : Theme.mutedText)
                    .lineLimit(10)
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
                DeliveredMediaView(path: f, projectId: projectId, token: token)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: helpers

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
