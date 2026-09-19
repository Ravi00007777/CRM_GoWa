#!/bin/sh
# Keep the relay running on a Mac: launchd starts gowa and the app at login and restarts
# either one if it dies. This is the local equivalent of the systemd units used on a server.
#   sh scripts/deploy/mac-install.sh            install and start
#   sh scripts/deploy/mac-install.sh uninstall   stop and remove
set -e
APP=$(cd "$(dirname "$0")/../.." && pwd)
AGENTS=$HOME/Library/LaunchAgents
# launchd creates the stdout/stderr file itself, before exec, and launchd is denied write access
# to Desktop/Documents/Downloads. A log path inside those folders makes the job die with
# EX_CONFIG and no message anywhere, so logs live under ~/Library/Logs instead.
LOGS=$HOME/Library/Logs/almaed
BACKUPS="$HOME/Library/Application Support/almaed-backups"
DOMAIN=gui/$(id -u)
LABELS="com.almaed.gowa com.almaed.app com.almaed.awake com.almaed.backup"

if [ "$1" = uninstall ]; then
  for l in $LABELS; do
    launchctl bootout "$DOMAIN/$l" 2>/dev/null || true
    rm -f "$AGENTS/$l.plist"
  done
  echo "Removed. Nothing starts at login any more."
  exit 0
fi

# nvm installs node outside /usr/local, and launchd does not read your shell profile,
# so the absolute path is baked in here. Re-run this script after switching node versions.
NODE=$(command -v node)
[ -x "$NODE" ] || { echo "node not found on PATH"; exit 1; }

mkdir -p "$AGENTS" "$LOGS" "$BACKUPS"

plist() { # label, program args (one per line, already xml-escaped)
  cat > "$AGENTS/$1.plist" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key><array>$2</array>
  <key>WorkingDirectory</key><string>$APP</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOGS/$3.log</string>
  <key>StandardErrorPath</key><string>$LOGS/$3.log</string>
</dict>
</plist>
XML
}

plist com.almaed.gowa "<string>/bin/sh</string><string>$APP/scripts/gowa.sh</string>" gowa
plist com.almaed.app "<string>$NODE</string><string>$APP/src/server.js</string>" app
# Without this the Mac sleeps and no message moves until you wake it. Remove this one agent
# (launchctl bootout gui/$(id -u)/com.almaed.awake) if you would rather let it sleep.
plist com.almaed.awake "<string>/usr/bin/caffeinate</string><string>-dimsu</string>" awake

# Nightly snapshot at 02:00. StartCalendarInterval instead of KeepAlive: this one runs and exits.
cat > "$AGENTS/com.almaed.backup.plist" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.almaed.backup</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>$APP/scripts/deploy/backup.sh</string></array>
  <key>WorkingDirectory</key><string>$APP</string>
  <key>EnvironmentVariables</key><dict><key>BACKUPS</key><string>$BACKUPS</string></dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>2</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$LOGS/backup.log</string>
  <key>StandardErrorPath</key><string>$LOGS/backup.log</string>
</dict>
</plist>
XML

# bootout is asynchronous: bootstrapping again too soon fails with "5: Input/output error",
# so each one gets a few tries.
for l in $LABELS; do
  launchctl bootout "$DOMAIN/$l" 2>/dev/null || true
  n=0
  until launchctl bootstrap "$DOMAIN" "$AGENTS/$l.plist" 2>/dev/null; do
    n=$((n + 1))
    [ "$n" -ge 5 ] && { echo "could not start $l"; break; }
    sleep 1
  done
done

sleep 3
echo
echo "Running:"
launchctl list | grep almaed || echo "  (nothing - check $LOGS/*.log)"
echo
echo "Logs:    tail -f $LOGS/app.log $LOGS/gowa.log"
echo "Backups: $BACKUPS (nightly 02:00, 14 kept)"
echo "Stop:    sh $APP/scripts/deploy/mac-install.sh uninstall"
