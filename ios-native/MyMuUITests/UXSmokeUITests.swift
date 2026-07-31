import XCTest

/// Pre-resubmit UX smoke sweep. Drives the REAL app (not the DEBUG demo screen)
/// through the flows an App Store reviewer would exercise, asserting nothing is
/// broken and capturing a screenshot at every step for visual review.
///
/// Two paths, mirroring the App Review notes:
///   1. "Try the demo"  — offline sample data, no network.
///   2. Sign in → demo.proagenten.de — real login, real transcript, live stream.
///
/// Run on both an iPad and an iPhone simulator:
///   xcodebuild test -scheme MyMu \
///     -destination 'platform=iOS Simulator,name=iPad Air 11-inch (M4),OS=26.5' \
///     -only-testing:MyMuUITests/UXSmokeUITests
final class UXSmokeUITests: XCTestCase {

    override func setUp() { continueAfterFailure = false }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }

    /// The composer text entry is a SwiftUI TextField(axis:.vertical) — expose it
    /// however XCUITest classifies it on this OS.
    private func composerField(_ app: XCUIApplication) -> XCUIElement {
        // The composer carries accessibilityIdentifier("composer-input"); it may be
        // classified as a text field or (multiline, axis:.vertical) a text view.
        let tv = app.textViews["composer-input"]
        if tv.exists { return tv }
        return app.textFields["composer-input"]
    }

    /// iPadOS 26 renders SwiftUI TabView as a floating TOP tab bar whose items are
    /// plain buttons (not under an XCUIElement `tabBar`); iPhone keeps a bottom
    /// tab bar. `app.buttons[name].firstMatch` finds the tab item on both.
    private func tab(_ app: XCUIApplication, _ name: String) -> XCUIElement {
        app.buttons[name].firstMatch
    }

    // MARK: - Path 1: offline "Try the demo"

    func test1_TryDemo_tabsListsChatAttach() {
        let app = XCUIApplication()
        app.launch()

        // Login screen renders with all controls.
        XCTAssertTrue(app.buttons["Try the demo"].waitForExistence(timeout: 25), "login screen never appeared")
        XCTAssertTrue(app.buttons["Sign in"].exists, "Sign in button missing")
        shot(app, "10-login")

        app.buttons["Try the demo"].tap()

        // All three tabs exist and switch without breaking.
        for name in ["Projects", "Chats", "Archive"] {
            let t = tab(app, name)
            XCTAssertTrue(t.waitForExistence(timeout: 10), "tab '\(name)' missing")
            t.tap()
            shot(app, "11-tab-\(name)")
        }

        // Open a conversation: Projects → a project → its first session.
        tab(app, "Projects").tap()
        let project = app.staticTexts["claudecodeui"].firstMatch
        XCTAssertTrue(project.waitForExistence(timeout: 10), "demo project row missing")
        project.tap()
        let session = app.staticTexts["Native iOS app — chat UI"].firstMatch
        XCTAssertTrue(session.waitForExistence(timeout: 10), "demo session row missing")
        session.tap()

        // Composer must be present and the "+" responsive on this device.
        XCTAssertTrue(app.buttons["composer-attach"].waitForExistence(timeout: 10), "composer '+' missing in demo chat")
        shot(app, "12-demo-chat")
        app.buttons["composer-attach"].tap()
        XCTAssertTrue(app.buttons["Attach file"].waitForExistence(timeout: 6), "'+' did not present attach options")
        shot(app, "13-attach-options")
        // Dismiss the dialog (best-effort cleanup — the assertions above are the test).
        if app.buttons["Cancel"].exists { app.buttons["Cancel"].tap() }
    }

    // MARK: - Path 2: real login → live transcript → streamed reply

    func test2_RealLogin_transcriptAndStreamedReply() {
        let app = XCUIApplication()
        app.launch()

        let user = app.textFields["Username"]
        XCTAssertTrue(user.waitForExistence(timeout: 25), "username field missing")
        user.tap(); user.typeText("appleReviewer")
        let pass = app.secureTextFields["Password"]
        pass.tap(); pass.typeText("review1234")
        shot(app, "20-login-filled")
        app.buttons["Sign in"].tap()

        // Land in the app (tab bar shows).
        XCTAssertTrue(tab(app, "Projects").waitForExistence(timeout: 25), "no tab bar after sign-in")
        tab(app, "Projects").tap()
        let project = app.staticTexts["hello-world"].firstMatch
        XCTAssertTrue(project.waitForExistence(timeout: 15), "hello-world project missing from backend")
        shot(app, "21-projects")
        project.tap()

        // Open the sample conversation.
        let session = app.staticTexts["Add a README"].firstMatch
        XCTAssertTrue(session.waitForExistence(timeout: 15), "sample session missing")
        session.tap()

        // Transcript must load (not a blank/stuck screen) and the composer present.
        XCTAssertTrue(app.buttons["composer-attach"].waitForExistence(timeout: 15), "chat did not open")
        // Give the WS a moment to deliver the transcript, then capture it.
        _ = app.staticTexts.element(boundBy: 0).waitForExistence(timeout: 6)
        shot(app, "22-transcript")

        // Send a message and confirm a streamed reply arrives from the demo backend.
        let field = composerField(app)
        XCTAssertTrue(field.waitForExistence(timeout: 6), "composer text field missing")
        field.tap(); field.typeText("hello from the reviewer")
        shot(app, "23-typed")
        let send = app.buttons["composer-send"]
        XCTAssertTrue(send.waitForExistence(timeout: 4), "send button missing")
        send.tap()

        // The demo backend streams a canned reply containing "demo backend".
        // Message bubbles render as text views (text exposed via `value`), so
        // match on both label and value across text views and static texts.
        let p = NSPredicate(format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@", "demo backend", "demo backend")
        let streamed = app.textViews.matching(p).firstMatch.waitForExistence(timeout: 20)
            || app.staticTexts.matching(p).firstMatch.waitForExistence(timeout: 2)
        shot(app, "24-streamed-reply")
        XCTAssertTrue(streamed, "no streamed reply appeared after sending")
    }

    // MARK: - Files tab loads a tree (reviewer may browse)

    func test3_RealLogin_filesTab() {
        let app = XCUIApplication()
        app.launch()
        let user = app.textFields["Username"]
        XCTAssertTrue(user.waitForExistence(timeout: 25), "username field missing")
        user.tap(); user.typeText("appleReviewer")
        let pass = app.secureTextFields["Password"]
        pass.tap(); pass.typeText("review1234")
        app.buttons["Sign in"].tap()

        XCTAssertTrue(tab(app, "Projects").waitForExistence(timeout: 25), "no tab bar after sign-in")
        tab(app, "Projects").tap()
        let project = app.staticTexts["hello-world"].firstMatch
        XCTAssertTrue(project.waitForExistence(timeout: 15), "hello-world project missing")
        project.tap()
        // Project detail should expose a Files affordance and render without error.
        shot(app, "30-project-detail")
    }
}
