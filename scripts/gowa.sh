#!/bin/sh
# Run gowa natively (no Docker). Downloads the checksum-verified macOS binary into ./gowa on first run.
set -e
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

VERSION=9.3.1
ARCH=$(uname -m | sed 's/x86_64/amd64/')
BIN=gowa/darwin-$ARCH
PORT_GOWA=$(echo "$GOWA_BASE_URL" | sed -E 's|.*:([0-9]+).*|\1|')

if [ ! -x "$BIN" ]; then
  mkdir -p gowa && cd gowa
  BASE=https://github.com/aldinokemal/go-whatsapp-web-multidevice/releases/download/v$VERSION
  ZIP=whatsapp_${VERSION}_darwin_$ARCH.zip
  curl -fsSLO "$BASE/$ZIP" && curl -fsSLO "$BASE/checksums-macos.txt"
  grep "$ZIP" checksums-macos.txt | shasum -a 256 -c -
  unzip -oq "$ZIP" && rm "$ZIP" checksums-macos.txt
  xattr -dr com.apple.quarantine . 2>/dev/null || true
  cd ..
fi

cd gowa # gowa keeps storages/ (WhatsApp sessions) and statics/ in its working directory
exec "./darwin-$ARCH" rest \
  --port="$PORT_GOWA" --os=Chrome \
  --basic-auth="$GOWA_BASIC_AUTH" \
  --webhook="http://localhost:${PORT:-8080}/webhook" \
  --webhook-secret="$WEBHOOK_SECRET" \
  --webhook-events=message \
  --webhook-ignore-jids=@g.us \
  --auto-download-media=true
