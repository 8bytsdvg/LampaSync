import AppKit

// TorrServer в строке меню: при запуске поднимает сервер, при выходе останавливает.
final class App: NSObject, NSApplicationDelegate {
    let dir = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/TorrServer")
    var item: NSStatusItem!
    var server: Process?
    var statusLine: NSMenuItem!
    var timer: Timer?

    func applicationDidFinishLaunching(_ n: Notification) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let img = NSImage(systemSymbolName: "arrow.down.circle", accessibilityDescription: "TorrServer")
        img?.isTemplate = true
        item.button?.image = img

        let menu = NSMenu()
        statusLine = NSMenuItem(title: "TorrServer: запуск…", action: nil, keyEquivalent: "")
        menu.addItem(statusLine)
        menu.addItem(.separator())
        menu.addItem(withTitle: "Открыть веб-панель", action: #selector(openPanel), keyEquivalent: "o")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Остановить TorrServer", action: #selector(quit), keyEquivalent: "q")
        menu.items.forEach { $0.target = self }
        item.menu = menu

        startServer()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.refresh() }
    }

    func startServer() {
        if isAlive() { refresh(); return } // уже запущен кем-то ещё
        let p = Process()
        p.executableURL = dir.appendingPathComponent("TorrServer")
        p.arguments = ["--port", "8090",
                       "--path", dir.appendingPathComponent("db").path,
                       "--logpath", dir.appendingPathComponent("torrserver.log").path]
        p.currentDirectoryURL = dir
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        p.terminationHandler = { _ in DispatchQueue.main.async { NSApp.terminate(nil) } }
        do { try p.run(); server = p } catch {
            statusLine.title = "Ошибка запуска: \(error.localizedDescription)"
        }
    }

    func isAlive() -> Bool {
        guard let url = URL(string: "http://127.0.0.1:8090/echo") else { return false }
        var ok = false
        let sem = DispatchSemaphore(value: 0)
        var req = URLRequest(url: url); req.timeoutInterval = 1
        URLSession.shared.dataTask(with: req) { _, r, _ in
            ok = (r as? HTTPURLResponse)?.statusCode == 200; sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 1.5)
        return ok
    }

    func refresh() {
        statusLine.title = isAlive() ? "TorrServer работает · 127.0.0.1:8090" : "TorrServer: запуск…"
    }

    @objc func openPanel() { NSWorkspace.shared.open(URL(string: "http://127.0.0.1:8090")!) }

    @objc func quit() {
        timer?.invalidate()
        if let p = server, p.isRunning {
            p.terminationHandler = nil
            p.terminate()
            p.waitUntilExit()
        }
        NSApp.terminate(nil)
    }

    func applicationWillTerminate(_ n: Notification) {
        if let p = server, p.isRunning { p.terminate() }
    }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
