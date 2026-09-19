#!/bin/sh
# Nightly SQLite snapshot, 14 kept. Works on macOS and on the server: paths are derived from
# where this script lives, so the same file serves both.
#   BACKUPS=<dir> overrides the destination (the launchd agent sets it).
# .backup is used rather than cp because the database runs in WAL mode and a plain copy can
# catch it mid-write.
set -e
APP=$(cd "$(dirname "$0")/../.." && pwd)
DIR=${BACKUPS:-$APP/backups}
mkdir -p "$DIR"
DEST=$DIR/crm-$(date +%F).db
sqlite3 "$APP/data/crm.db" ".backup '$DEST'"
# sqlite3 opens the destination in WAL mode too and leaves empty sidecars behind. The snapshot
# is complete once it exits, and the prune glob below would never match them.
rm -f "$DEST-wal" "$DEST-shm"
# Prune oldest beyond 14. Portable: no xargs -r, which BSD xargs lacks.
ls -1t "$DIR"/crm-*.db 2>/dev/null | tail -n +15 | while read -r f; do rm -f "$f"; done
echo "$(date '+%F %T') backed up to $DIR"
