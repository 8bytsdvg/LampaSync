import AppKit

// Фоновый помощник: TorrServer работает ровно тогда, когда открыта Лампа.
// Стартует при входе в систему (LaunchAgent), без значка и окон. macOS сама сообщает
// о запуске и закрытии приложений (без опроса): открыли Лампу — сервер запустился,
// закрыли — остановился. Открыть TorrServer.app вручную без Лампы — включить сервер,
// открыть ещё раз — выключить.
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

    func applicationDidFinishLaunching(_ n: Notification) {
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
            manual = false
            startServer()
        }
    }

    @objc func appTerminated(_ n: Notification) {
        if isLampa(n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication) {
            manual = false
            stopServer()
        }
    }

    func startServer() {
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
app.setActivationPolicy(.prohibited)
app.run()
