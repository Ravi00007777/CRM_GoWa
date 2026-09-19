#!/bin/sh
# Run gowa natively (no Docker). Downloads the checksum-verified binary into ./gowa on first run.
# Works on macOS (local dev) and Linux (the 1 GB free-tier VM, where Docker is too heavy).
set -e
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

VERSION=9.3.1
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')
BIN=gowa/$OS-$ARCH
PORT_GOWA=$(echo "$GOWA_BASE_URL" | sed -E 's|.*:([0-9]+).*|\1|')

if [ ! -x "$BIN" ]; then
  mkdir -p gowa && cd gowa
  BASE=https://github.com/aldinokemal/go-whatsapp-web-multidevice/releases/download/v$VERSION
  ZIP=whatsapp_${VERSION}_${OS}_$ARCH.zip
  # macOS builds are signed separately and have their own checksum file.
  [ "$OS" = darwin ] && SUMS=checksums-macos.txt || SUMS=checksums.txt
  curl -fsSLO "$BASE/$ZIP" && curl -fsSLO "$BASE/$SUMS"
  if command -v sha256sum >/dev/null; then grep "$ZIP" "$SUMS" | sha256sum -c -
  else grep "$ZIP" "$SUMS" | shasum -a 256 -c -; fi
  command -v unzip >/dev/null || { echo "unzip is required"; exit 1; }
  unzip -oq "$ZIP" && rm "$ZIP" "$SUMS"
  [ "$OS" = darwin ] && xattr -dr com.apple.quarantine . 2>/dev/null || true
  cd ..
fi

cd gowa # gowa keeps storages/ (WhatsApp sessions) and statics/ in its working directory
exec "./$OS-$ARCH" rest \
  --port="$PORT_GOWA" --os=Chrome \
  --basic-auth="$GOWA_BASIC_AUTH" \
  --webhook="http://localhost:${PORT:-8080}/webhook" \
  --webhook-secret="$WEBHOOK_SECRET" \
  --webhook-events=message \
  --auto-download-media=true
