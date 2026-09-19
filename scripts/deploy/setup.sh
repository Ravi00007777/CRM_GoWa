#!/bin/sh
# One-shot VPS setup, run as root on a fresh Ubuntu 24.04 box:
#   git clone <repo> /opt/almaed && sh /opt/almaed/scripts/deploy/setup.sh
# Idempotent: safe to re-run after a git pull.
set -e
APP=/opt/almaed

[ -f "$APP/.env" ] || { echo "Create $APP/.env first (copy .env.example and fill it in)"; exit 1; }

echo "--- packages"
apt-get update -qq
apt-get install -y -qq sqlite3 ufw ca-certificates curl gnupg unzip
# Ubuntu 24.04 ships Node 18; better-sqlite3 needs >= 22, so take it from NodeSource.
[ "$(node -v 2>/dev/null | cut -c2- | cut -d. -f1)" -ge 22 ] 2>/dev/null || {
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
}

# No Docker: on a 1 GB VM the daemon costs more memory than the relay itself, so gowa runs
# as a native binary under its own unit instead.
echo "--- swap (1 GB VMs have no headroom for an npm install)"
[ -f /swapfile ] || {
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
}
echo "--- user"
id almaed >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin almaed
mkdir -p "$APP/data" "$APP/backups" "$APP/gowa"
chown -R almaed:almaed "$APP"

echo "--- app"
cd "$APP"
sudo -u almaed npm ci --omit=dev

# The relay serves only a webhook that gowa posts to over loopback, and a health check. Nothing
# needs to reach it from outside, so only SSH is open and gowa's own port stays unreachable.
echo "--- firewall: ssh only"
ufw allow 22/tcp >/dev/null
ufw --force enable >/dev/null

echo "--- services"
install -m 644 "$APP/scripts/deploy/almaed.service" /etc/systemd/system/almaed.service
install -m 644 "$APP/scripts/deploy/gowa.service" /etc/systemd/system/gowa.service
systemctl daemon-reload
systemctl enable --now gowa almaed

echo "--- nightly backup"
echo "0 2 * * * $APP/scripts/deploy/backup.sh" | crontab -u almaed -

cat <<'DONE'

Done. Remaining, by hand:
  1. Pair both numbers again on THIS machine - sessions do not move between installs.
     Reach gowa through an SSH tunnel, since its port is not open:
       ssh -L 3002:localhost:3002 <user>@<this host>
       AUTH=$(grep GOWA_BASIC_AUTH /opt/almaed/.env | cut -d= -f2)
       curl -u $AUTH -X POST localhost:3002/devices -H 'Content-Type: application/json' -d '{"device_id":"teacher"}'
       curl -u $AUTH localhost:3002/devices/teacher/login     # open qr_link, scan from the teacher phone
       curl -u $AUTH -X POST localhost:3002/devices -H 'Content-Type: application/json' -d '{"device_id":"student"}'
       curl -u $AUTH localhost:3002/devices/student/login     # scan from the student phone
       curl -u $AUTH localhost:3002/devices                   # both should say "logged_in"
  2. Check: systemctl status gowa almaed && journalctl -u almaed -u gowa -f
DONE
