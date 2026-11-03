# integrations —— 外部集成适配器（占位）

外部接口族（料品、订单、收货回传、投料、形态转换等 13 族）全部缺真实报文样例、协议、账号与字段映射
（见 `architecture/contracts/prep/p1/02-external-interface-facts-T02.md` A/B 节）。
P1 只落平台机制（outbox/inbox），模拟适配器与真实联调在后续 WorkItem 按冻结合同实现，
不预造 URL、账户、凭据。

## SAP_SIM（2026-10-29）

见 `sap-sim/README.md`：专用模拟适配 + outbox/inbox HTTP；`actual_connection=false`。
