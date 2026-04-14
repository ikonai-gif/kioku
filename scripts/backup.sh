#!/bin/bash
# KIOKU™ Database Backup Script
# Runs via GitHub Actions Cron or manually
# Uploads to Cloudflare R2 (or any S3-compatible storage)

set -euo pipefail

DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="kioku_backup_${DATE}.sql.gz"
BACKUP_PATH="/tmp/${BACKUP_FILE}"

echo "[backup] Starting backup at $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Dump database
if [ -z "${DATABASE_URL:-}" ]; then
  echo "[backup] ERROR: DATABASE_URL not set"
  exit 1
fi

pg_dump "$DATABASE_URL" --no-owner --no-acl | gzip > "$BACKUP_PATH"
SIZE=$(du -h "$BACKUP_PATH" | cut -f1)
echo "[backup] Dump complete: ${BACKUP_FILE} (${SIZE})"

# Upload to S3/R2 if configured
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  aws s3 cp "$BACKUP_PATH" "s3://${BACKUP_S3_BUCKET}/backups/${BACKUP_FILE}" \
    --endpoint-url "${BACKUP_S3_ENDPOINT:-https://s3.amazonaws.com}"
  echo "[backup] Uploaded to s3://${BACKUP_S3_BUCKET}/backups/${BACKUP_FILE}"
  
  # Cleanup: remove backups older than 30 days
  CUTOFF=$(date -d '-30 days' +%Y%m%d 2>/dev/null || date -v-30d +%Y%m%d)
  aws s3 ls "s3://${BACKUP_S3_BUCKET}/backups/" \
    --endpoint-url "${BACKUP_S3_ENDPOINT:-https://s3.amazonaws.com}" | \
    awk '{print $4}' | while read -r file; do
      FILE_DATE=$(echo "$file" | grep -oP '\d{8}' | head -1)
      if [ -n "$FILE_DATE" ] && [ "$FILE_DATE" -lt "$CUTOFF" ]; then
        aws s3 rm "s3://${BACKUP_S3_BUCKET}/backups/${file}" \
          --endpoint-url "${BACKUP_S3_ENDPOINT:-https://s3.amazonaws.com}"
        echo "[backup] Deleted old backup: ${file}"
      fi
    done
else
  echo "[backup] No BACKUP_S3_BUCKET set — backup saved locally only: ${BACKUP_PATH}"
fi

# Cleanup local temp
rm -f "$BACKUP_PATH"
echo "[backup] Done at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
