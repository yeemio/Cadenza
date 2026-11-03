# im —— IM 渠道边缘包（P4-C 线，frozen/p4/im-channels.md）

承载且仅承载（IM-01）：渠道协议适配（企微/飞书载荷 ↔ 统一消息，IM-02）、mock 双向通道（IM-15）、
身份绑定端口（IM-03）、发送端口（IM-04）、渠道事件处理记录与去重键（IM-06/07，首版包内存储 IM-05）。

## 红线（违反=返工）

- **真实验签解密 = SITE_PENDING 桩（IM-16，GAP-P2）**：企微/飞书回调验签、消息解密、
  access_token/ticket、企业应用凭据全部为待授权桩——`SitePendingImError [IM-16-1]`。
  未经 Owner 授权不接真实端点、不落真实凭据、不产生外呼。
- **凭据边界（IM-17）**：凭据只存服务端凭据配置，不进提示词/页面/聊天/普通日志；本包零凭据字段。
- **发送未知态（IM-04）**：`SendResult.status='unknown'` 不得冒称严格送达、不自动补发。
- **绑定关系不是权限（IM-03）**：权限按 AQ-AUTH-01 每次由接入层重算。

## 包状态（L0 整合注意）

本目录当前**不是 pnpm workspace 成员**（`pnpm-workspace.yaml` 只匹配 `packages/*` 一级目录，
`packages/integrations/package.json` 为既有占位文件不可改）：`pnpm -r` 不执行本包
build/typecheck 脚本；apps/api 侧通过端口注入组合消费本包实现（不直接 import，见
`apps/api/src/aiquery/im/im.ports.ts` 的 [L0-整合标记]）。测试经相对路径直接消费 TS 源码。
升格动作见 `delivery/P4/im/DELIVERY.md` L0 整合清单。
