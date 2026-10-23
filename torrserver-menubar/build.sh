#!/bin/zsh
# Собирает TorrServer.app (значок в строке меню) в ~/Applications.
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
mkdir -p ~/Applications && rm -rf ~/Applications/TorrServer.app && cp -R $A ~/Applications/
echo "Готово: ~/Applications/TorrServer.app"
