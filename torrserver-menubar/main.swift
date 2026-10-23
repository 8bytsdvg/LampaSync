import AppKit

// Фоновый помощник: TorrServer работает ровно тогда, когда открыта Лампа.
// Стартует при входе в систему (LaunchAgent), без значка и окон. macOS сама сообщает
// о запуске и закрытии приложений (без опроса): открыли Лампу — сервер запустился,
// закрыли — остановился. Открыть TorrServer.app вручную без Лампы — включить сервер
// со значком в строке меню (там же «Остановить»); открыть ещё раз — выключить.
final class App: NSObject, NSApplicationDelegate {
    let dir = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/TorrServer")
    let lampaURL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Applications/Lampa.app")
    var binary: String { dir.appendingPathComponent("TorrServer").path }
    var server: Process?
    var manual = false              // сервер включён вручную, без Лампы
    var crashes: [Date] = []        // для ограничения перезапусков
    var signals: [DispatchSourceSignal] = []
    var item: NSStatusItem!
    var statusLine: NSMenuItem!
    var timer: Timer?

    func applicationDidFinishLaunching(_ n: Notification) {
        // Значок в строке меню — только когда сервер включён вручную (из «Программ»)
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

        // Помощника завершили (выход из системы, launchctl, обновление) — сервер не должен остаться сиротой
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            src.setEventHandler { [weak self] in self?.stopServer(); exit(0) }
            src.resume()
            signals.append(src)
        }

        let nc = NSWorkspace.shared.notificationCenter
        nc.addObserver(self, selector: #selector(appLaunched(_:)), name: NSWorkspace.didLaunchApplicationNotification, object: nil)
        nc.addObserver(self, selector: #selector(appTerminated(_:)), name: NSWorkspace.didTerminateApplicationNotification, object: nil)

        let atLogin = ProcessInfo.processInfo.arguments.contains("--background")
        if lampaRunning() {
            startServer()
        } else if atLogin {
            killStrays() // сервер, оставшийся от прошлого запуска без Лампы
        } else {
            manual = true
            startServer()
        }
    }

    // Повторное открытие TorrServer.app без Лампы: включить/выключить сервер вручную
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if lampaRunning() {
            startServer()
        } else if manual, let p = server, p.isRunning {
            manual = false
            stopServer()
        } else {
            manual = true
            startServer()
        }
        return false
    }

    func isLampa(_ app: NSRunningApplication?) -> Bool {
        guard let url = app?.bundleURL else { return false }
        return url.standardizedFileURL.path == lampaURL.standardizedFileURL.path
    }

    func lampaRunning() -> Bool {
        NSWorkspace.shared.runningApplications.contains { isLampa($0) && !$0.isTerminated }
    }

    @objc func appLaunched(_ n: Notification) {
        if isLampa(n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication) {
            manual = false // дальше сервер принадлежит Лампе: значок прячем, выключится вместе с ней
            startServer()
        }
    }

    @objc func appTerminated(_ n: Notification) {
        if isLampa(n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication) {
            manual = false
            stopServer()
        }
    }

    // Значок виден только в ручном режиме, пока сервер работает
    func updateIcon() {
        let show = manual && (server?.isRunning ?? false)
        item.isVisible = show
        if show && timer == nil {
            refresh()
            timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.refresh() }
        } else if !show {
            timer?.invalidate(); timer = nil
        }
    }

    func refresh() {
        guard let url = URL(string: "http://127.0.0.1:8090/echo") else { return }
        var req = URLRequest(url: url); req.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: req) { [weak self] _, r, _ in
            let ok = (r as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async {
                self?.statusLine.title = ok ? "TorrServer работает · 127.0.0.1:8090" : "TorrServer: запуск…"
            }
        }.resume()
    }

    @objc func openLampa() { NSWorkspace.shared.open(lampaURL) }
    @objc func openPanel() { NSWorkspace.shared.open(URL(string: "http://127.0.0.1:8090")!) }
    @objc func stopFromMenu() { manual = false; stopServer() }

    func startServer() {
        defer { updateIcon() }
        if let p = server, p.isRunning { return }
        killStrays() // чужой/осиротевший экземпляр занял бы порт и не подчинялся бы нам
        let p = Process()
        p.executableURL = URL(fileURLWithPath: binary)
        p.arguments = ["--port", "8090",
                       "--path", dir.appendingPathComponent("db").path,
                       "--logpath", dir.appendingPathComponent("torrserver.log").path]
        p.currentDirectoryURL = dir
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        p.terminationHandler = { [weak self] _ in DispatchQueue.main.async { self?.serverCrashed() } }
        do { try p.run(); server = p } catch { NSLog("TorrServer start failed: \(error)") }
    }

    // Сервер завершился сам: пока он нужен (Лампа открыта или включён вручную) — перезапускаем,
    // но не больше 3 раз за минуту, чтобы не крутиться при постоянной ошибке (например, занят порт)
    func serverCrashed() {
        server = nil
        defer { updateIcon() }
        crashes = crashes.filter { $0.timeIntervalSinceNow > -60 } + [Date()]
        guard (manual || lampaRunning()) && crashes.count <= 3 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self = self, self.manual || self.lampaRunning() else { return }
            self.startServer()
        }
    }

    func stopServer() {
        if let p = server, p.isRunning {
            p.terminationHandler = nil
            p.terminate()
            p.waitUntilExit()
        }
        server = nil
        killStrays()
        updateIcon()
    }

    // Оставшиеся процессы нашего TorrServer — запущенные по полному или относительному пути
    // («./TorrServer --port …» от старых запускалок). Шаблон привязан к началу командной строки,
    // чтобы не задеть посторонние процессы, в аргументах которых просто встречается это имя.
    func killStrays() {
        let escaped = NSRegularExpression.escapedPattern(for: binary)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        p.arguments = ["-f", "^(\\./TorrServer|" + escaped + ") --port 8090"]
        try? p.run()
        p.waitUntilExit()
    }

    func applicationWillTerminate(_ n: Notification) { stopServer() }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
