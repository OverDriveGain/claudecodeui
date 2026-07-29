import XCTest

/// Regression test for the App Store 2.1(a) rejection (submission c5bff108):
/// on iPad the composer "+" was "unresponsive" and no file/document could be
/// attached. Root cause: the old code toggled `.fileImporter`/`.photosPicker`
/// from inside a SwiftUI `Menu`, whose popover dismissal on iPad swallowed the
/// picker presentation. The fix routes the "+" through a `confirmationDialog`.
///
/// Run on an iPad simulator (the bug is iPad-only):
///   xcodebuild test -scheme MyMu \
///     -destination 'platform=iOS Simulator,name=iPad Air 11-inch (M4),OS=26.5' \
///     -only-testing:MyMuUITests/ComposerAttachUITests
final class ComposerAttachUITests: XCTestCase {

    override func setUp() { continueAfterFailure = false }

    /// Tapping "+" must (a) present the attachment options — proving the button
    /// is responsive — and (b) actually present a picker when an option is
    /// chosen. On the rejected build, (b) never happened on iPad.
    func testAttachButtonPresentsDocumentPicker() {
        let app = XCUIApplication()
        app.launchEnvironment["MYMU_DEMO"] = "chat"   // DEBUG-only: boots straight into a ChatView
        app.launch()

        let plus = app.buttons["composer-attach"]
        XCTAssertTrue(plus.waitForExistence(timeout: 20), "composer '+' button never appeared")
        plus.tap()

        // (a) The attachment options must appear. The reviewer described the "+"
        //     as unresponsive — if this fails, that is exactly the reported bug.
        let attachFile = app.buttons["Attach file"]
        XCTAssertTrue(attachFile.waitForExistence(timeout: 6),
                      "'+' did not present attachment options — this is the reviewer's 'unresponsive' bug")
        add(screenshot(app, name: "01-attach-options"))

        // (b) Choosing "Attach file" must present the document picker. On the old
        //     Menu-based code this silently no-op'd on iPad.
        attachFile.tap()
        let picker = documentPickerPresented(app, timeout: 12)
        add(screenshot(app, name: "02-document-picker"))
        XCTAssertTrue(picker, "document picker did not present after choosing 'Attach file' (the iPad bug)")
    }

    /// The photo-library path shares the same presentation trap, so guard it too.
    func testAttachButtonPresentsPhotoPicker() {
        let app = XCUIApplication()
        app.launchEnvironment["MYMU_DEMO"] = "chat"
        app.launch()

        let plus = app.buttons["composer-attach"]
        XCTAssertTrue(plus.waitForExistence(timeout: 20), "composer '+' button never appeared")
        plus.tap()

        let photo = app.buttons["Photo library"]
        XCTAssertTrue(photo.waitForExistence(timeout: 6), "'+' did not present attachment options")
        photo.tap()

        // PHPicker presents in a sheet with a "Photos"/"Cancel" affordance.
        let presented = app.buttons["Cancel"].waitForExistence(timeout: 12)
            || app.navigationBars.firstMatch.waitForExistence(timeout: 3)
        add(screenshot(app, name: "03-photo-picker"))
        XCTAssertTrue(presented, "photo picker did not present after choosing 'Photo library'")
    }

    // MARK: - helpers

    /// The document browser is cross-process; probe several stable affordances so
    /// the check survives iOS-version label drift.
    private func documentPickerPresented(_ app: XCUIApplication, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if app.buttons["Cancel"].exists { return true }              // picker nav "Cancel"
            if app.searchFields.firstMatch.exists { return true }        // browser search bar
            if app.navigationBars["Recents"].exists { return true }      // default browser tab
            if app.otherElements["DOC.browsingViewController"].exists { return true }
            _ = app.wait(for: .runningForeground, timeout: 0.5)
        }
        return false
    }

    private func screenshot(_ app: XCUIApplication, name: String) -> XCTAttachment {
        let att = XCTAttachment(screenshot: app.screenshot())
        att.name = name
        att.lifetime = .keepAlways
        return att
    }
}
