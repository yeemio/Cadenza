#!/usr/bin/env bash
# 安装后重启自检入口（T26，DO-04）。用法：
#   ./selfcheck.sh --database-url URL [--api-url http://…/health] [--anchor FILE] [--repo-root DIR]
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ "${1:-}" == "--repo-root" ]]; then REPO_ROOT="${2:?--repo-root 须带值}"; shift 2; fi
exec node "$REPO_ROOT/scripts/delivery/install/selfcheck.mjs" "$@"
