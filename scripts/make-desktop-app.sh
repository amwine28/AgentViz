#!/bin/bash
# Build a double-clickable AgentViz.app (macOS).
#
# The app: starts the AgentViz relay (if it isn't already up) and opens a
# CHROMELESS Chrome window pointing at it — so AgentViz reads as a standalone
# app, not a browser tab. It opens to an EMPTY screen; terminals appear only as
# you run `agentviz` in them.
#
# Usage:  bash scripts/make-desktop-app.sh [target-dir]
#   target-dir defaults to ~/Desktop. The bundle is <target>/AgentViz.app.
#
# Re-runnable: rebuilds the bundle in place. Delete the .app to uninstall.
# Why a generator instead of a committed .app: the bundle bakes THIS machine's
# repo path + PATH into its launcher (a Finder-launched app gets a minimal PATH
# and wouldn't find node/python otherwise), so it must be built locally.
set -e

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${1:-$HOME/Desktop}"
APP="$TARGET_DIR/AgentViz.app"
CHROME_APP="/Applications/Google Chrome.app"

[ -d "$TARGET_DIR" ] || { echo "[make-app] no such dir: $TARGET_DIR" >&2; exit 1; }

echo "[make-app] building $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# --- launcher executable (baked PATH + repo path so Finder launch works) -----
# A Finder-launched app does NOT inherit your shell PATH, so node/npm/python3
# would be missing. Bake the dirs that resolve them now, plus the usual spots.
BAKED_PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:$HOME/.local/bin"
cat > "$APP/Contents/MacOS/AgentViz" <<LAUNCHER
#!/bin/bash
export PATH="$BAKED_PATH:\$PATH"
exec bash "$REPO/scripts/agentviz.sh" --app-window >> /tmp/agentviz-app.log 2>&1
LAUNCHER
chmod +x "$APP/Contents/MacOS/AgentViz"

# --- icon (best-effort: render → iconset → icns; HAS_ICON gates the plist) ----
HAS_ICON=0
make_icon() {
  command -v sips >/dev/null 2>&1 || return 1
  command -v iconutil >/dev/null 2>&1 || return 1
  [ -d "$CHROME_APP" ] || return 1
  local tmp; tmp="$(mktemp -d)"
  cat > "$tmp/icon.html" <<'HTML'
<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:1024px;height:1024px;background:transparent}
  .sq{position:absolute;inset:96px;border-radius:200px;
      background:radial-gradient(120% 120% at 50% 0%,#3a72a3 0%,#2b5f8c 60%,#234f76 100%);}
  svg{position:absolute;inset:0}
  .e{stroke:#eaf2fb;stroke-width:9;opacity:.85}
  .n{fill:#ffffff}
  .hub{fill:#eaf2fb}
</style></head><body>
  <div class="sq"></div>
  <svg viewBox="0 0 1024 1024">
    <line class="e" x1="512" y1="512" x2="320" y2="330"/>
    <line class="e" x1="512" y1="512" x2="720" y2="338"/>
    <line class="e" x1="512" y1="512" x2="360" y2="700"/>
    <line class="e" x1="512" y1="512" x2="690" y2="690"/>
    <line class="e" x1="512" y1="512" x2="512" y2="752"/>
    <circle class="hub" cx="512" cy="512" r="62"/>
    <circle class="n" cx="320" cy="330" r="34"/>
    <circle class="n" cx="720" cy="338" r="34"/>
    <circle class="n" cx="360" cy="700" r="34"/>
    <circle class="n" cx="690" cy="690" r="34"/>
    <circle class="n" cx="512" cy="752" r="34"/>
  </svg>
</body></html>
HTML
  "$CHROME_APP/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=1 --window-size=1024,1024 --default-background-color=00000000 \
    --screenshot="$tmp/icon.png" "file://$tmp/icon.html" >/dev/null 2>&1 || { rm -rf "$tmp"; return 1; }
  [ -f "$tmp/icon.png" ] || { rm -rf "$tmp"; return 1; }
  local set="$tmp/AgentViz.iconset"; mkdir -p "$set"
  # iconutil expects exactly these names/sizes
  sips -z 16  16   "$tmp/icon.png" --out "$set/icon_16x16.png"      >/dev/null 2>&1
  sips -z 32  32   "$tmp/icon.png" --out "$set/icon_16x16@2x.png"   >/dev/null 2>&1
  sips -z 32  32   "$tmp/icon.png" --out "$set/icon_32x32.png"      >/dev/null 2>&1
  sips -z 64  64   "$tmp/icon.png" --out "$set/icon_32x32@2x.png"   >/dev/null 2>&1
  sips -z 128 128  "$tmp/icon.png" --out "$set/icon_128x128.png"    >/dev/null 2>&1
  sips -z 256 256  "$tmp/icon.png" --out "$set/icon_128x128@2x.png" >/dev/null 2>&1
  sips -z 256 256  "$tmp/icon.png" --out "$set/icon_256x256.png"    >/dev/null 2>&1
  sips -z 512 512  "$tmp/icon.png" --out "$set/icon_256x256@2x.png" >/dev/null 2>&1
  sips -z 512 512  "$tmp/icon.png" --out "$set/icon_512x512.png"    >/dev/null 2>&1
  cp "$tmp/icon.png" "$set/icon_512x512@2x.png"
  iconutil -c icns "$set" -o "$APP/Contents/Resources/AgentViz.icns" >/dev/null 2>&1 || { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
  return 0
}
if make_icon; then HAS_ICON=1; echo "[make-app] icon: built AgentViz.icns"; else echo "[make-app] icon: skipped (needs Chrome+sips+iconutil) — generic app icon"; fi

# --- Info.plist (icon key only when we actually have an icon) -----------------
ICON_KEY=""
[ "$HAS_ICON" = 1 ] && ICON_KEY="  <key>CFBundleIconFile</key><string>AgentViz</string>"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>AgentViz</string>
  <key>CFBundleDisplayName</key><string>AgentViz</string>
  <key>CFBundleIdentifier</key><string>com.agentviz.launcher</string>
  <key>CFBundleVersion</key><string>2.0</string>
  <key>CFBundleShortVersionString</key><string>2.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>AgentViz</string>
$ICON_KEY
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# nudge LaunchServices to register the bundle + icon
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true

echo "[make-app] done → $APP"
echo "[make-app] double-click it (or: open \"$APP\"). It opens an empty AgentViz window;"
echo "[make-app] then run \`agentviz\` in any terminal to add that terminal as a tab."
[ -d "$CHROME_APP" ] || echo "[make-app] NOTE: Chrome not found — the app falls back to your default browser (a normal tab)."
