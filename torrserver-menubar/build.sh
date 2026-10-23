#!/bin/zsh
# Собирает TorrServer.app (фоновый помощник: TorrServer работает, пока открыта Лампа) в ~/Applications.
# Сам TorrServer (бинарник) должен лежать в ~/Library/Application Support/TorrServer/TorrServer
set -e
cd "$(dirname "$0")"
A=build/TorrServer.app
rm -rf build && mkdir -p $A/Contents/MacOS $A/Contents/Resources
swiftc -O -o $A/Contents/MacOS/TorrServerMenu main.swift
cat > $A/Contents/Info.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>TorrServer</string>
  <key>CFBundleIdentifier</key><string>local.torrserver.menu</string>
  <key>CFBundleExecutable</key><string>TorrServerMenu</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
</dict></plist>
PLIST
codesign --force -s - $A
osascript -e 'quit app id "local.torrserver.menu"' 2>/dev/null || true
mkdir -p ~/Applications && rm -rf ~/Applications/TorrServer.app && cp -R $A ~/Applications/

# Автозапуск при входе в систему в фоновом режиме: сервер включается вместе с Лампой
PL=~/Library/LaunchAgents/local.torrserver.menu.plist
mkdir -p ~/Library/LaunchAgents
cat > $PL <<AGENT
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.torrserver.menu</string>
  <key>ProgramArguments</key><array>
    <string>$HOME/Applications/TorrServer.app/Contents/MacOS/TorrServerMenu</string>
    <string>--background</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict></plist>
AGENT
launchctl bootout gui/$(id -u)/local.torrserver.menu 2>/dev/null || true
# дождаться выгрузки старого помощника, иначе bootstrap может не пройти
for i in {1..20}; do launchctl print gui/$(id -u)/local.torrserver.menu >/dev/null 2>&1 || break; sleep 0.25; done
for i in {1..5}; do launchctl bootstrap gui/$(id -u) $PL 2>/dev/null && break; sleep 1; done
echo "Готово: TorrServer будет включаться вместе с Лампой и выключаться при её закрытии"
