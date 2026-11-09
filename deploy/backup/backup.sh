#!/usr/bin/env bash
# Cadenza backup: canonical DATABASE_URL only; native psql/pg_dump/pg_restore clients required.
# PG_CONTAINER / --pg-container is rejected before dump or database recreation.
# Restore retains cadenza_dops_* whitelist and exact --target-confirm database-name guard.
set -euo pipefail
CADENZA_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec node "$CADENZA_REPO_ROOT/scripts/delivery/backup/backup.mjs" "$@"
