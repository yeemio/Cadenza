# @cadenza/ui

Cadenza 公共 UI 组件与前端 API 客户端（apps/web 与 apps/pda 共用）。

- 主题：`src/theme.css`（中文、工厂风格简洁；应用入口 `import '@cadenza/ui/theme.css'`）
- 组件：Button / Input(Select/Textarea/Field) / Form / Table(服务端分页) / Message(含确认弹窗 ConfirmModal) / Modal / PageContainer / Badge(含 MockBadge 演示数据标识) / Tree(机构树) / ScanInput(键盘楔入扫描输入)
- API 客户端：`createApiClient`（mock/live 双模式、baseURL 可配、统一错误体→ApiError、401 回调、分页参数）；mock 样例数据对齐 `architecture/contracts/frozen/p1/org-auth.md` 字段
- 错误文案：`src/api/errorMessages.ts` 集中管理（PC-15 中文首发）

消费方式：工作区源码模式（main/exports 指向 `src/index.ts`），vite/vitest 经 alias 消费源码；`pnpm --filter @cadenza/ui build` 另产出 `dist/`（tsc + theme.css 拷贝）。只消费公开合同与 API，不引用存储层。
