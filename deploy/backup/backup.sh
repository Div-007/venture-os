#!/bin/bash
# MongoDB backups for the local production stack.
#   backup.sh loop            run forever: a full compressed dump every BACKUP_INTERVAL_HOURS (default 24)
#   backup.sh now             take one backup immediately
#   backup.sh verify [file]   restore a backup (default: newest) into a throwaway database, exactly as a real restore would
#   backup.sh restore <file>  replace the live database with a backup (run through prod.ps1, which stops the app first)
set -uo pipefail

DIR=/backups
INTERVAL_HOURS=${BACKUP_INTERVAL_HOURS:-24}
KEEP_LOCAL_DAYS=${BACKUP_KEEP_LOCAL_DAYS:-14}
KEEP_REMOTE_DAYS=${BACKUP_KEEP_REMOTE_DAYS:-30}
PREFIX=${BACKUP_R2_PREFIX:-mongo}
URI="mongodb://root:${MONGO_ROOT_PASSWORD}@mongo:27017/?replicaSet=rs0&authSource=admin"
LOCK="$DIR/.restore-in-progress"
UPLOAD_FAILED="$DIR/.upload-failed"

log() { echo "$(date -u +%FT%TZ) $*"; }

remote_enabled() {
  [ -n "${BACKUP_R2_BUCKET:-}" ] && [ -n "${BACKUP_R2_ACCESS_KEY_ID:-}" ] && [ -n "${BACKUP_R2_SECRET_ACCESS_KEY:-}" ] && [ -n "${BACKUP_R2_ENDPOINT:-}" ]
}

if remote_enabled; then
  export RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare
  export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$BACKUP_R2_ACCESS_KEY_ID" RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$BACKUP_R2_SECRET_ACCESS_KEY"
  export RCLONE_CONFIG_R2_ENDPOINT="$BACKUP_R2_ENDPOINT" RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
fi

newest() { ls -1t "$DIR"/venture-studio-*.archive.gz 2>/dev/null | head -1; }

# Copies the newest local backup to R2. A failure leaves a marker (the container turns unhealthy) and is retried hourly
# without taking another full dump.
upload_newest() {
  remote_enabled || { rm -f "$UPLOAD_FAILED"; return 0; }
  local file
  file=$(newest)
  [ -n "$file" ] || return 0
  if rclone copyto "$file" "r2:$BACKUP_R2_BUCKET/$PREFIX/$(basename "$file")"; then
    rm -f "$UPLOAD_FAILED"
    log "uploaded $(basename "$file") to R2"
    rclone delete "r2:$BACKUP_R2_BUCKET/$PREFIX" --min-age "${KEEP_REMOTE_DAYS}d" --include "venture-studio-*.archive.gz" \
      || log "warning: could not prune old R2 copies (the token needs delete access, or use an R2 lifecycle rule)"
  else
    date -u +%FT%TZ > "$UPLOAD_FAILED"
    log "UPLOAD FAILED: $(basename "$file") is saved locally; check the BACKUP_R2_* settings. Retrying hourly."
    return 1
  fi
}

run_backup() {
  mkdir -p "$DIR"
  if [ -f "$LOCK" ]; then log "skipped: a restore is in progress (or failed; see $LOCK)"; return 1; fi
  local stamp file tmp
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  file="$DIR/venture-studio-$stamp.archive.gz"
  tmp="$file.partial"
  log "backup started"
  if ! mongodump --uri="$URI" --oplog --archive="$tmp" --gzip --quiet; then
    rm -f "$tmp"; log "BACKUP FAILED: mongodump could not read the database"; return 1
  fi
  mv "$tmp" "$file"
  find "$DIR" -maxdepth 1 -name 'venture-studio-*.archive.gz' -mtime +"$KEEP_LOCAL_DAYS" -delete
  date -u +%FT%TZ > "$DIR/.last-success"
  log "backup ok: $(basename "$file") ($(du -h "$file" | cut -f1))"
  if remote_enabled; then upload_newest; else log "note: R2 backup settings are empty, so this copy is local only"; fi
}

# Restores the whole archive with the same flags as a real restore, but into a scratch mongod inside this container.
verify_backup() {
  local file=${1:-$(newest)}
  [ -n "$file" ] && [ -f "$file" ] || { log "no backup file found"; return 1; }
  gzip -t "$file" || { log "VERIFY FAILED: $(basename "$file") is not a valid gzip file"; return 1; }
  local scratch=/tmp/verify-db port=27999
  rm -rf "$scratch"; mkdir -p "$scratch"
  mongod --dbpath "$scratch" --port "$port" --bind_ip 127.0.0.1 --wiredTigerCacheSizeGB 0.25 --fork --logpath /tmp/verify-mongod.log --quiet >/dev/null \
    || { log "could not start the scratch database"; return 1; }
  local ok=0
  if mongorestore --uri="mongodb://127.0.0.1:$port" --archive="$file" --gzip --oplogReplay --drop --quiet; then
    log "restore test of $(basename "$file") succeeded; documents per collection:"
    mongosh --quiet "mongodb://127.0.0.1:$port/${MONGODB_DB:-venture_studio}" --eval 'db.getCollectionNames().sort().forEach((name) => print("  " + name + ": " + db.getCollection(name).countDocuments()))'
  else
    ok=1; log "VERIFY FAILED: $(basename "$file") could not be restored"
  fi
  mongosh --quiet "mongodb://127.0.0.1:$port/admin" --eval 'db.shutdownServer()' >/dev/null 2>&1
  rm -rf "$scratch"
  return $ok
}

restore_backup() {
  local file=${1:-}
  [ -n "$file" ] && [ -f "$file" ] || { log "RESTORE FAILED: backup file not found: ${file:-<none>}"; return 1; }
  gzip -t "$file" || { log "RESTORE FAILED: $(basename "$file") is damaged (gzip check failed); nothing was changed"; return 1; }
  date -u +%FT%TZ > "$LOCK"
  # A safety copy of the current state first, named outside the pruned venture-studio-* pattern.
  local safety
  safety="$DIR/pre-restore-$(date -u +%Y%m%dT%H%M%SZ).archive.gz"
  if ! mongodump --uri="$URI" --oplog --archive="$safety" --gzip --quiet; then
    rm -f "$safety" "$LOCK"; log "RESTORE CANCELLED: could not take a safety copy of the current database; nothing was changed"; return 1
  fi
  log "safety copy of the current database: $(basename "$safety")"
  log "restoring $(basename "$file") over the live database"
  # A point-in-time restore replays the oplog captured during the dump, which mongorestore only allows for the whole
  # archive. That includes the database users, so restore with the same deploy/.env passwords the backup was taken with.
  if mongorestore --uri="$URI" --archive="$file" --gzip --oplogReplay --drop --quiet; then
    rm -f "$LOCK"; log "restore complete"
  else
    log "RESTORE FAILED: the database may be partly restored. Scheduled backups are paused (see $LOCK)."
    log "To go back to how it was before, restore the safety copy: $(basename "$safety")"
    return 1
  fi
}

case "${1:-loop}" in
  now) run_backup ;;
  verify) verify_backup "${2:-}" ;;
  restore) restore_backup "${2:-}" ;;
  loop)
    mkdir -p "$DIR"
    log "backup service started: every ${INTERVAL_HOURS}h, keeping ${KEEP_LOCAL_DAYS} days locally"
    while true; do
      if [ -z "$(find "$DIR" -maxdepth 1 -name '.last-success' -mmin -$((INTERVAL_HOURS * 60)) 2>/dev/null)" ]; then
        run_backup || log "will retry in 1 hour"
      elif [ -f "$UPLOAD_FAILED" ]; then
        upload_newest || true
      fi
      sleep 3600
    done ;;
  *) echo "usage: backup.sh loop|now|verify [file]|restore <file>"; exit 2 ;;
esac
