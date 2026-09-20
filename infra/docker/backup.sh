#!/usr/bin/env sh
# Encrypted backup of the production database, copied off the server.
#
#   ./backup.sh                 # from infra/docker, reads .env.prod
#   17 3 * * * cd /srv/krypta/infra/docker && ./backup.sh >> /var/log/krypta-backup.log 2>&1
#
# What it saves, and why only this:
#   postgres  pg_dump in custom format: every account, form, response,
#             wrapper and membership. Content is ciphertext, but the users
#             table holds emails, verifier hashes and TOTP secrets in the
#             clear, which is why the dump is encrypted before it is written.
#   attachments  NOT here. They live in the external object store named by
#             S3_* in .env.prod, which is durable and versioned on its own.
#             A restored database points at objects that are still there.
#   redis     NOT here. Sessions, rate-limit counters and 15-minute pending
#             signups; losing it logs everyone out and nothing more.
#
# The dump is piped straight through `age` to BACKUP_AGE_RECIPIENT, so
# plaintext never touches disk. Keep the private key somewhere that is not
# this server. When BACKUP_S3_BUCKET is set the encrypted file is then
# uploaded there with the AWS CLI; use a separate bucket and a key that can
# write but not delete, so a compromised server cannot erase its history.
#
# Restore, on a stopped stack with an empty postgres volume:
#   aws --endpoint-url "$BACKUP_S3_ENDPOINT" s3 cp "s3://$BACKUP_S3_BUCKET/postgres-<ts>.dump.age" .
#   age -d -i key.txt postgres-<ts>.dump.age > /tmp/krypta.dump
#   docker compose --env-file .env.prod -f docker-compose.prod.yml up -d postgres
#   docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres \
#       pg_restore -U krypta -d krypta --clean --if-exists < /tmp/krypta.dump
#   docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
set -eu

cd "$(dirname "$0")"
[ -f .env.prod ] || { echo "backup: .env.prod not found next to this script" >&2; exit 1; }
# shellcheck disable=SC1091
set -a; . ./.env.prod; set +a

: "${BACKUP_AGE_RECIPIENT:?backup: set BACKUP_AGE_RECIPIENT in .env.prod (an age1... public key)}"
command -v age >/dev/null 2>&1 || { echo "backup: age is not installed" >&2; exit 1; }
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  command -v aws >/dev/null 2>&1 || { echo "backup: BACKUP_S3_BUCKET is set but the aws CLI is not installed" >&2; exit 1; }
  : "${BACKUP_S3_ENDPOINT:?backup: set BACKUP_S3_ENDPOINT}"
  : "${BACKUP_S3_ACCESS_KEY:?backup: set BACKUP_S3_ACCESS_KEY}"
  : "${BACKUP_S3_SECRET_KEY:?backup: set BACKUP_S3_SECRET_KEY}"
fi

BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$BACKUP_DIR"
umask 077

OUT="$BACKUP_DIR/postgres-$STAMP.dump.age"
docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U krypta -Fc krypta \
  | age -r "$BACKUP_AGE_RECIPIENT" > "$OUT.partial"
mv "$OUT.partial" "$OUT"

if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY" \
  AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_KEY" \
  AWS_DEFAULT_REGION="${BACKUP_S3_REGION:-us-east-1}" \
  aws --endpoint-url "$BACKUP_S3_ENDPOINT" s3 cp --only-show-errors "$OUT" "s3://$BACKUP_S3_BUCKET/$(basename "$OUT")"
  OFFSITE="uploaded to s3://$BACKUP_S3_BUCKET"
else
  OFFSITE="LOCAL ONLY: set BACKUP_S3_BUCKET to copy it off this server"
fi

# Retention is local only; the bucket keeps its own, longer history.
find "$BACKUP_DIR" -name '*.age' -type f -mtime +"$KEEP_DAYS" -delete

echo "backup: $STAMP ok $(du -h "$OUT" | cut -f1) postgres -> $OUT; $OFFSITE"
