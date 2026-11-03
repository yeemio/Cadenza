# Cadenza 安装手册（非开发者适用）

适用：T26 干净安装（DO-02：安装步骤可由非开发者按说明完成，A13）｜版本锚：`deploy/release/RELEASE-ANCHOR.json`

> 本文所有命令在发行包根目录执行。`DATABASE_URL` 换成现场目标库连接串（本文以演示环境 `postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza_install_demo` 为例——**安装要求空库**，主库/已用库会被干净检查拒绝）。

## 1. 你需要准备什么

| 项 | 要求 | 怎么确认 |
| --- | --- | --- |
| 服务器 | macOS / Linux，Node.js ≥ 24 | `node -v` |
| 容器运行时 | Docker（数据库用，本仓库形态为 `postgres:17-alpine`） | `docker --version` |
| 数据库 | PostgreSQL 17 空库一个（干净环境，无既有表） | 向管理员索取连接串 |
| 发行包 | 本仓库发行包（含 `pnpm-lock.yaml` 与构建产物） | 目录内有 `packages/persistence/dist/cli.js` |

## 2. 启动数据库（已用现成数据库可跳过）

```bash
docker compose up -d        # 开发形态：cadenza-dev-pg @127.0.0.1:55433
docker compose ps           # 等到 STATUS 为 healthy
```

另建空库（示例，库名可自定；**不要**用 cadenza 主库）：

```bash
docker exec cadenza-dev-pg psql -U postgres -d postgres -c "CREATE DATABASE cadenza_install_demo ENCODING 'UTF8'"
```

## 3. 解包与构建（一次性）

```bash
pnpm install
pnpm build
```

## 4. 执行安装

```bash
# 生产安装（默认不含演示数据，DO-03）
./deploy/install/install.sh --database-url postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza_install_demo

# 演示/培训环境（装载匿名演示数据）
./deploy/install/install.sh --database-url … --with-demo
```

脚本会依次执行（每步失败都会停下并给出中文原因）：

1. 环境版本锚校验（DO-05）：Node/PostgreSQL 主版本/容器运行时与发行锚不符即**拒绝**；
2. 干净环境检查（DO-02）：目标库已有任何表即**拒绝**——请换空库；
3. 数据库迁移（幂等，重复执行自动跳过已应用版本）；
4. 组织/角色/用户种子（幂等；演示凭据仅占值，生产另行签发）；
5. 演示数据（仅 `--with-demo`；走期初导入同一校验通道）；
6. 安装后自检（DO-04）。

## 5. 启动应用并做重启自检

```bash
# API（默认端口 3001，可 PORT=xxxx 自定）
DATABASE_URL=postgres://… PORT=3001 node apps/api/dist/main.js &
# Worker（Outbox 派发）
DATABASE_URL=postgres://… node apps/worker/dist/main.js &

# 重启自检（DO-04：空模块配置/密钥失效在重启后才暴露——必须做）
./deploy/install/selfcheck.sh --database-url postgres://… --api-url http://127.0.0.1:3001/health
```

自检输出 `[DO-04] 安装后重启自检通过` 才算安装完成。

## 6. 常见失败与处置

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| `[DO-05] PostgreSQL 主版本：锚要求 17，目标库为 16` | 环境与发行锚不匹配 | 换 PostgreSQL 17，或由现场负责人重新生成发行锚 |
| `[DO-02 干净安装] 目标库已有 N 张表` | 非干净环境 | 换空库；确需重装先由管理员确认并清理 |
| `dist/cli.js 不存在` | 未构建 | 回到第 3 节执行 `pnpm build` |
| 自检报 `DATABASE_URL 未显式提供` | 用了回落默认 | 启动与自检都显式传 `DATABASE_URL` |
| 自检报健康端点不可达 | 应用未启动/端口不符 | 检查 api 进程与 PORT；重跑自检 |

## 7. 升级 / 备份恢复

不在本手册范围：升级见 `deploy/upgrade/MANUAL-升级手册.md`；备份恢复见 `deploy/backup/MANUAL-备份恢复手册.md`；总纲见 `deploy/MANUAL-运维手册.md`。
