#!/bin/sh
# apps/ai 构建脚本（P4-B）：
#   以仓库根为 rootDir、把 apps/ai/src 与 packages/integrations/dsh 源码编译进同一输出树
#   apps/ai/dist/（CJS；dsh 随程序共发射，运行期相对导入可达，产物全部落在 B 线 owned paths 内）。
#   入口：node apps/ai/dist/apps/ai/src/main.js
#
# Registered workspace package. dsh remains co-emitted; no extra package or runtime path rewrite.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
rm -rf "$ROOT/apps/ai/dist"
"$ROOT/node_modules/.bin/tsc" -p "$ROOT/apps/ai/tsconfig.build.json"
echo "[build] apps/ai dist 已生成：$ROOT/apps/ai/dist/apps/ai/src/main.js"
