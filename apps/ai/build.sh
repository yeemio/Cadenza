#!/bin/sh
# apps/ai 构建脚本（P4-B）：
#   以仓库根为 rootDir、把 apps/ai/src 与 packages/integrations/dsh 源码编译进同一输出树
#   apps/ai/dist/（CJS；dsh 随程序共发射，运行期相对导入可达，产物全部落在 B 线 owned paths 内）。
#   入口：node apps/ai/dist/apps/ai/src/main.js
#
# [L0-整合标记] apps/ai 故意不带 package.json：pnpm-workspace.yaml 的 apps/* glob 会把
#   带包描述的目录自动注册进 workspace（连带改 pnpm-lock.yaml=共享文件，本线禁改）。
#   L0 整合时如需将 apps/ai 注册为 workspace 包：新增 apps/ai/package.json（scripts.build
#   指向本目录构建）、为 packages/integrations/dsh 补独立包描述与构建，并把本脚本与
#   dsh 共发射逻辑收编/删除。届时删除本标记。
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
rm -rf "$ROOT/apps/ai/dist"
"$ROOT/node_modules/.bin/tsc" -p "$ROOT/apps/ai/tsconfig.build.json"
echo "[build] apps/ai dist 已生成：$ROOT/apps/ai/dist/apps/ai/src/main.js"
