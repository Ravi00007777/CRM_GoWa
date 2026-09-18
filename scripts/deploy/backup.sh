#!/bin/sh
# Nightly SQLite snapshot, 14 kept. Run from cron as the almaed user:
#   0 2 * * * /opt/almaed/scripts/deploy/backup.sh
# .backup is used rather than cp because the database runs in WAL mode and a plain copy
# can catch it mid-write.
set -e
DIR=/opt/almaed/backups
mkdir -p "$DIR"
sqlite3 /opt/almaed/data/crm.db ".backup '$DIR/crm-$(date +%F).db'"
ls -1t "$DIR"/crm-*.db | tail -n +15 | xargs -r rm --
