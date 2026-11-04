# PR07 R1 — PG 工厂夹具修正

在 PR07 R0 完整补丁 SHA256 `a95a0e5dc88a63890a970cb50c33dd538a60ec71f63208db86820d048e3e4c91` 后应用 `pr07-r1-on-r0.patch`。原父 head `fe1f8bb4acc253747e6e95ddfd55f421e62b49d6` 不变。

仅修 tests/pr07/confirmation.pg.spec.ts 的新工厂 INSERT，补 schema 必填 parent_kind/path/depth，沿用真实父法人层级、以新 UUID 构造 path；产品源码不变。R0 原件保留，后续验收以 R1 后像为准。

测试文件前像 `505e729c5f783fbb61783138b11df158d29608c8ff8791321df9da888e5d1aa5`；后像 `170b8b2c7fc0e8107a6ab7038ff9f93a09b27cf3e2640e073b916129f0c2b4b2`。R1 全部源码/测试集合摘要 `f42b4823ce3fe2768bcd9f73e4f490955abf42b8451ce6355eff3d88bd772177`，不是 Git commit。

最终测试类型检查 exit 0。20 个未变本地规则用例及产品类型检查复用 R0 证据。20 个真实 PG 用例仍 0 执行 / NOT_RUN；本次是 schema 静态核对发现的夹具修正，不是 PG PASS。主控接受仍待完成。
