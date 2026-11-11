import AppKit
import WebKit

final class SliderApp: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var service: Process?
    private var serviceInput: Pipe?
    private var serviceOutput: Pipe?
    private var outputBuffer = Data()
    private var origin: URL?
    private var sessionToken: String?
    private var pageReady = false
    private var reusedService = false
    private var serviceFailed = false
    private var quitting = false
    private var finished = false
    private var deferredTermination = false
    private var startTimer: Timer?
    private var stopTimer: Timer?
    private var stopStarted = Date()

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        startService()
    }

    private func buildMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu(title: "Codex Slider")
        appMenu.addItem(withTitle: "About Codex Slider", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Codex Slider", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Codex Slider", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        for (title, action, key) in [("Undo", "undo:", "z"), ("Redo", "redo:", "Z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        editItem.submenu = edit
        menu.addItem(editItem)
        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(withTitle: "Close", action: #selector(closeWindow), keyEquivalent: "w").target = self
        windowItem.submenu = windowMenu
        menu.addItem(windowItem)
        NSApp.mainMenu = menu
        NSApp.windowsMenu = windowMenu
    }

    private func buildWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 620, height: 780),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Codex Slider"
        window.minSize = NSSize(width: 540, height: 640)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.addUserScript(WKUserScript(source: "window.__CODEX_SLIDER_DESKTOP__ = true;", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        configuration.userContentController.add(self, name: "sliderHost")
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        window.contentView = webView
        // This page is local to the executable and has no links or script.
        webView.loadHTMLString("<!doctype html><html lang='en'><meta name='color-scheme' content='light dark'><body style='font:14px -apple-system;text-align:center;padding:110px 20px'><h2>Opening Codex Slider</h2><p>Preparing your local editor…</p></body></html>", baseURL: nil)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func startService() {
        let offlineNode: String?
        do { offlineNode = try HostPolicy.offlineNode(Array(CommandLine.arguments.dropFirst())) }
        catch { showFailure("The application launch options are invalid."); return }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let result = Result { try NodeRuntime.resolve(candidates: offlineNode.map { [$0] }) }
            DispatchQueue.main.async {
                guard let self, !self.quitting else { return }
                switch result {
                case .success(let node): self.launchService(node)
                case .failure: self.showNodeRequirement()
                }
            }
        }
    }

    private func showNodeRequirement() {
        serviceFailed = true
        let alert = NSAlert()
        alert.messageText = "Node.js is required"
        alert.informativeText = NodeRuntime.instructions
        alert.addButton(withTitle: "Get Node.js")
        alert.addButton(withTitle: "Quit")
        alert.beginSheetModal(for: window) { [weak self] reply in
            if reply == .alertFirstButtonReturn { NSWorkspace.shared.open(NodeRuntime.downloadURL) }
            self?.beginShutdown()
        }
    }

    private func launchService(_ node: NodeRuntime.Selection) {
        do {
            guard let resources = Bundle.main.resourceURL else { throw hostError() }
            let runtime = URL(fileURLWithPath: node.path)
            let entry = resources.appendingPathComponent("app/app.mjs")
            guard FileManager.default.isExecutableFile(atPath: runtime.path), FileManager.default.fileExists(atPath: entry.path) else { throw hostError() }
            let arguments = try HostPolicy.serviceArguments(Array(CommandLine.arguments.dropFirst()))
            let child = Process()
            child.executableURL = runtime
            child.arguments = [entry.path] + arguments
            child.currentDirectoryURL = resources.appendingPathComponent("app")
            var environment = NodeRuntime.environment()
            if let codexHome = ProcessInfo.processInfo.environment["CODEX_HOME"] { environment["CODEX_HOME"] = codexHome }
            child.environment = environment
            let input = Pipe()
            let output = Pipe()
            child.standardInput = input
            child.standardOutput = output
            child.standardError = FileHandle.nullDevice
            service = child
            serviceInput = input
            serviceOutput = output
            output.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let data = handle.availableData
                if data.isEmpty { handle.readabilityHandler = nil; return }
                DispatchQueue.main.async { self?.receive(data) }
            }
            child.terminationHandler = { [weak self] _ in
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { self?.serviceExited() }
            }
            try child.run()
            // Only the child keeps its stdin read end; host EOF must be observable.
            input.fileHandleForReading.closeFile()
            output.fileHandleForWriting.closeFile()
            startTimer = Timer.scheduledTimer(withTimeInterval: 20, repeats: false) { [weak self] _ in
                self?.showFailure("Codex Slider took too long to open. Please try again.")
            }
        } catch {
            showFailure("Codex Slider could not start. Reinstall the application and try again.")
        }
    }

    private func hostError() -> Error { NSError(domain: "CodexSlider", code: 1) }

    private func receive(_ data: Data) {
        guard !quitting, origin == nil else { return }
        outputBuffer.append(data)
        guard outputBuffer.count <= 65536 else { showFailure("The local editor returned an invalid startup response."); return }
        guard let end = outputBuffer.firstIndex(of: 10) else { return }
        let line = outputBuffer[..<end]
        guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
              let value = object["origin"] as? String, let url = HostPolicy.localOrigin(value),
              let token=HostPolicy.sessionToken(object["token"]),
              let request=HostPolicy.sessionRequest(url,token:token) else {
            showFailure("The local editor could not open. Please try again."); return
        }
        origin = url
        sessionToken = token
        reusedService = object["reused"] as? Bool == true
        startTimer?.invalidate()
        webView.load(request)
    }

    private func serviceExited() {
        if quitting { completeShutdown(); return }
        if reusedService { return }
        serviceFailed = true
        if !pageReady { showFailure("The local editor stopped before it was ready. Reopen Codex Slider to try again.") }
        // An existing page retains its unsaved draft and displays its connection error.
    }

    private func showFailure(_ message: String) {
        guard !quitting else { return }
        startTimer?.invalidate()
        serviceFailed = true
        let alert = NSAlert()
        alert.messageText = "Codex Slider could not open"
        alert.informativeText = message
        alert.addButton(withTitle: "Quit")
        alert.beginSheetModal(for: window) { [weak self] _ in self?.beginShutdown() }
    }

    @objc private func closeWindow() { requestClose() }

    private func requestClose() {
        guard !quitting else { return }
        if serviceFailed && pageReady {
            let alert = NSAlert()
            alert.messageText = "Close Codex Slider?"
            alert.informativeText = "The local service is unavailable. Unsaved changes cannot be saved. Your previously saved presets are safe."
            alert.addButton(withTitle: "Keep Open")
            alert.addButton(withTitle: "Close")
            alert.beginSheetModal(for: window) { [weak self] reply in
                if reply == .alertSecondButtonReturn { self?.beginShutdown() }
            }
        } else if pageReady {
            webView.evaluateJavaScript("window.codexSliderDesktop.requestClose()") { [weak self] _, error in
                if error != nil { self?.serviceFailed = true }
            }
        } else { beginShutdown() }
    }

    private func beginShutdown() {
        guard !quitting else { return }
        quitting = true
        startTimer?.invalidate()
        serviceInput?.fileHandleForWriting.closeFile()
        if service?.isRunning != true || reusedService { completeShutdown(); return }
        stopStarted = Date()
        stopTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            guard let self else { return }
            if self.service?.isRunning != true { self.completeShutdown() }
            else if Date().timeIntervalSince(self.stopStarted) > 4 { self.service?.terminate() }
        }
    }

    private func completeShutdown() {
        guard !finished else { return }
        finished = true
        stopTimer?.invalidate()
        serviceOutput?.fileHandleForReading.readabilityHandler = nil
        if deferredTermination { NSApp.reply(toApplicationShouldTerminate: true) }
        else { NSApp.terminate(nil) }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if finished { return .terminateNow }
        if !pageReady || quitting {
            deferredTermination = true
            DispatchQueue.main.async { self.beginShutdown() }
            return .terminateLater
        }
        requestClose()
        return .terminateCancel
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool { requestClose(); return false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        return true
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.protocol == origin?.scheme,
              message.frameInfo.securityOrigin.host == origin?.host,
              message.frameInfo.securityOrigin.port == origin?.port,
              let body = message.body as? [String: String] else { return }
        if body["type"] == "ready" { pageReady = true }
        else if body["type"] == "closed" { beginShutdown() }
    }

    func webView(_ view: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if HostPolicy.isLocal(action.request.url, origin: origin) {
            if action.targetFrame?.isMainFrame == true, action.request.httpMethod == "GET",
               action.request.url?.path == "/" || action.request.url?.path == "",
               let token=sessionToken, action.request.value(forHTTPHeaderField:"X-Codex-Slider-Token") != token,
               let url=action.request.url,let request=HostPolicy.sessionRequest(url,token:token) {
                decisionHandler(.cancel);view.load(request);return
            }
            decisionHandler(.allow); return
        }
        if origin == nil && action.request.url?.absoluteString == "about:blank" { decisionHandler(.allow); return }
        if action.navigationType == .linkActivated && HostPolicy.externalLink(action.request.url), let url = action.request.url { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    func webView(_ view: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if !pageReady && !quitting && (error as NSError).code != NSURLErrorCancelled { showFailure("The local editor could not load. Please reopen Codex Slider.") }
    }

    func webViewWebContentProcessDidTerminate(_ view: WKWebView) {
        pageReady = false
        showFailure("The editor window stopped. Reopen Codex Slider to restore your saved presets.")
    }
}

// The verified installer uses this dependency-only check before changing any App.
// No AppKit session, local server, model reader or Codex connection is started.
if Array(CommandLine.arguments.dropFirst()) == ["--check-node"] {
    do {
        let selected = try NodeRuntime.resolve()
        FileHandle.standardOutput.write(try JSONEncoder().encode(selected))
        FileHandle.standardOutput.write(Data("\n".utf8))
        exit(0)
    } catch {
        FileHandle.standardError.write(Data(("Codex Slider: " + NodeRuntime.instructions + "\n").utf8))
        exit(2)
    }
}

do {
    if let arguments = try HostPolicy.compatibilityCommand(Array(CommandLine.arguments.dropFirst())) {
        let node = try NodeRuntime.resolve()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node.path)
        process.arguments = [Bundle.main.resourceURL!.appendingPathComponent("app/app.mjs").path] + arguments
        var environment = NodeRuntime.environment()
        if let codexHome = ProcessInfo.processInfo.environment["CODEX_HOME"] { environment["CODEX_HOME"] = codexHome }
        process.environment = environment
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.standardOutput
        process.standardError = FileHandle.standardError
        try process.run()
        process.waitUntilExit()
        exit(process.terminationStatus)
    }
} catch {
    FileHandle.standardError.write(Data(("Codex Slider: compatibility maintenance failed. " + error.localizedDescription + "\n").utf8))
    exit(2)
}

let application = NSApplication.shared
let delegate = SliderApp()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
