import AppKit

// TorrServer в строке меню, привязанный к Лампе.
// Работает в фоне с входа в систему и ничего не показывает. macOS сама сообщает о запуске
// и закрытии приложений (без опроса): открыли Лампу — сервер запускается и появляется значок,
// закрыли Лампу — сервер останавливается и значок пропадает.
// Открыть TorrServer.app вручную — запустить сервер без Лампы.
final class App: NSObject, NSApplicationDelegate {
    let dir = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/TorrServer")
    let lampaURL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Applications/Lampa.app")
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
        menu.addItem(withTitle: "Открыть Лампу", action: #selector(openLampa), keyEquivalent: "l")
        menu.addItem(withTitle: "Открыть веб-панель", action: #selector(openPanel), keyEquivalent: "o")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Остановить TorrServer", action: #selector(stopFromMenu), keyEquivalent: "q")
        menu.items.forEach { $0.target = self }
        item.menu = menu
        item.isVisible = false

        let nc = NSWorkspace.shared.notificationCenter
        nc.addObserver(self, selector: #selector(appLaunched(_:)), name: NSWorkspace.didLaunchApplicationNotification, object: nil)
        nc.addObserver(self, selector: #selector(appTerminated(_:)), name: NSWorkspace.didTerminateApplicationNotification, object: nil)

        // Запущены при входе в систему — ждём Лампу; открыты вручную — сразу включаем сервер
        let atLogin = ProcessInfo.processInfo.arguments.contains("--background")
        if lampaRunning() || !atLogin { startServer() }
    }

    // Повторное открытие TorrServer.app, когда он уже работает в фоне
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        startServer()
        return false
    }

    func isLampa(_ app: NSRunningApplication?) -> Bool {
        guard let url = app?.bundleURL else { return false }
        return url.standardizedFileURL.path == lampaURL.standardizedFileURL.path
    }

    func lampaRunning() -> Bool {
        NSWorkspace.shared.runningApplications.contains { isLampa($0) }
    }

    @objc func appLaunched(_ n: Notification) {
        if isLampa(n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication) { startServer() }
    }

    @objc func appTerminated(_ n: Notification) {
        if isLampa(n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication) { stopServer() }
    }

    func startServer() {
        item.isVisible = true
        if timer == nil {
            timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.refresh() }
        }
        if let p = server, p.isRunning { refresh(); return }
        if isAlive() { refresh(); return } // уже запущен кем-то ещё
        let p = Process()
        p.executableURL = dir.appendingPathComponent("TorrServer")
        p.arguments = ["--port", "8090",
                       "--path", dir.appendingPathComponent("db").path,
                       "--logpath", dir.appendingPathComponent("torrserver.log").path]
        p.currentDirectoryURL = dir
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        p.terminationHandler = { [weak self] _ in DispatchQueue.main.async { self?.serverExited() } }
        do { try p.run(); server = p } catch {
            statusLine.title = "Ошибка запуска: \(error.localizedDescription)"
        }
        refresh()
    }

    func stopServer() {
        if let p = server, p.isRunning {
            p.terminationHandler = nil
            p.terminate()
            p.waitUntilExit()
        }
        server = nil
        serverExited()
    }

    // Сервер остановлен или упал — прячем значок до следующего запуска Лампы
    func serverExited() {
        server = nil
        timer?.invalidate()
        timer = nil
        item.isVisible = false
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

    @objc func openLampa() { NSWorkspace.shared.open(lampaURL) }
    @objc func openPanel() { NSWorkspace.shared.open(URL(string: "http://127.0.0.1:8090")!) }
    @objc func stopFromMenu() { stopServer() }

    func applicationWillTerminate(_ n: Notification) {
        if let p = server, p.isRunning { p.terminate() }
    }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
