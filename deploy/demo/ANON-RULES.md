# 匿名演示数据规则（T25 / DO-14）

版本：2026-10-28｜随发行版本版本化（见 `deploy/release/RELEASE-MANIFEST.json` 四件分离之「种子/演示数据」指纹）

## 1. 定位与边界

- 演示数据是**合成数据**：随发行版本提供匿名完整工厂数据包（`deploy/demo/demo-dataset/`），用于演示、培训、试点前演练。
- 生产安装**默认不含演示数据**（`deploy/install/install.sh` 仅在显式 `--with-demo` 时装载，DO-03）；演示数据永不进入生产库。
- 真实工厂数据**未经授权不进入演示/测试包**：由 `scripts/delivery/demo-anon-check.mjs` 强制（禁入词命中即 FAIL）。

## 2. 脱敏字段（必须为空或「演示」前缀占位）

| 字段域 | 处理 |
| --- | --- |
| 客户（客户名称） | 空，或「演示客户A/B…」占位 |
| 供应商（供应商名称） | 空，或「演示供应商…」占位 |
| 联系人 / 地址 / 电话 | 演示数据包不含这些列 |
| 真实工厂标识（含 PRD 公司名称） | 禁入词表硬拦截（默认表：河北华通；现场可经 `--blocklist-extra` 追加） |

## 3. 保留数据分布

- 演示数据包每个 CSV ≥ 5 行（`MIN_ROWS_PER_FILE`，与检查工具同口径），覆盖多料品类型（成品/半成品/原材料）与多质量状态（qualified/pending_inspection/suspect），保留数量量级差异——不拿两行均质数据冒充"完整工厂数据"。
- 现场如需更大规模分布，按同规则扩包后必须重跑 `demo-anon-check.mjs`。

## 4. 装载方式（--with-demo）

1. 安装脚本先完成干净安装与种子（组织/角色/用户）。
2. 执行 `deploy/demo/demo-bootstrap.sql`（幂等）：演示单位「千克」、演示仓库 0101、库位 01010001/01010002。
3. 用期初导入工具按分层装载 `demo-dataset/demo-materials.csv`（第 1 层）与 `demo-inventory.csv`（第 2 层，须先设冻结点）——演示库与真实导入走**同一条被校验的通道**，无旁路。

## 5. 检查

```bash
node scripts/delivery/demo-anon-check.mjs --dataset deploy/demo/demo-dataset
```

FAIL 时禁止将数据包并入发行版本。
