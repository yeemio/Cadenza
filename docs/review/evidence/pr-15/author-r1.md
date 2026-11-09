# PR15 author R1 — 测量物理根路径与测试 Vite 类型上下文

状态：**源码窄修完成；38项本地回归PASS；完整UI类型门禁受环境依赖阻塞，未PASS；真实配对字节测量NOT_RUN；主控验收待定。**

## 准确绑定

- 原PR15 / codex/fix-15-frontend-loading；唯一父head：`a8ea17df961837680a715c5dae295ba07cb3c238`。
- 父源/测：`e68c604cd1463e4a05efc39b840e4edebbc0f6f0`；原19路径fingerprint：`811cc44d9f4d968f2273f6240f3576a974a3d733aa735bbff264cb04816bfc7c`。
- 已接受PR13 `e7a9985c87f02aa95bff6a3322140cc25bf969f5` 已在父中，不重放前置。
- R1的20路径fingerprint：`fc2eb9a66984334f92e657cba89bc75c0ac20c38341218595f1e02b90ae3ac0f`。原19路径保留，增加1个专项测试；原17路径未变。
- 新外部测量配方SHA256：`c52d9a471311c1e352289b594aa5d7f4da450de6c50c37631e96f1e6d7964e25`。

## 仅三处代码路径

1. tests/ui/pr15.tsconfig.json：仅增加compilerOptions.types，保留vitest/globals并加入vite/client；extends/include不变，不改生产或共享全局声明。
2. tests/ui/pr15-measure-build.mjs：请求root与receipt的source通过realpathSync按实际物理目录比较；同一目录的真实别名可通过，内容相同但物理目录不同仍拒绝。临时输出根、Vite入口、应用root、config和子进程cwd使用物理路径。记录请求/物理root与receipt实际路径、原始SHA、sourceManifest SHA和文件数；通过脚本别名调用外部CLI也正常进入。没有改生产Vite配置。
3. tests/ui/pr15-physical-root.test.mjs：新增15项针对性本地证明；实际创建文件系统符号链接，覆盖双向别名、不同物理目录、非UI源文件修改、完整清单/数量/摘要、锁/状态/不安全路径、子进程实际派发参数，以及别名CLI的真实缺输入拒绝。

完整tracked-source读取/哈希/数量检查代码段逐字节不变；inputFiles、readBuildMetrics、compareMeasurements整体逐字节不变。工具链、配方、lock、mode、成功状态和危险路径检查保留。新测试中的child build是显式替身，最终刻意返回NOT_MEASURED，合成guard receipt仅是单元夹具，不充作真实冷构建或字节证明。

## 保留与验证

原12个产品App/lazy mount/Vite文件全部原样保留；原23个Node场景及断言、16个UI场景及断言源码原样保留。产品、迁移、冻结合同、接受的PR13及所有旧失败/主控证据均不在本增量中改写。

最终实跑：

- node --test tests/ui/pr15-physical-root.test.mjs：**15 PASS /0fail/0skip，退出0**。
- node --test tests/ui/pr15-loading-structure.test.mjs：**23 PASS /0fail/0skip，退出0**。
- 两个JS的node --check：PASS。
- 合计38本地有效唯一；先前14专项和23原Node的初次通过日志保留，不重复累加。

类型证据分开报告：

- tsc -p tests/ui/pr15.tsconfig.json --noEmit：**实际退出2，未通过**。本地缓存缺Testing Library、React及其它UI依赖/类型，原始完整输出保留（811,425字节，SHA256 `a40cb8ce5bb0f3bd9cf7ea1ede269cbf70352ab897822110c817b7335ff3c9e9`），共5161条诊断，不将其称为PASS或未执行。
- --showConfig退出0，确认types包含vitest/globals与vite/client；--listFilesOnly退出0，实际解析了Vite client.d.ts及types/importMeta.d.ts。
- 该完整诊断流中ImportMeta.env错误为0；这只证明本次声明上下文已生效，不替代缺依赖环境下的完整UI类型接受。
- 主控需在具备当前锁定完整依赖的R1工作区补跑同一类型命令；本轮不修改测试实现或生产声明以绕过错误。

原16 React/jsdom mock-API PASS及12入口冷构建PASS保留复用，不重新执行或称为本轮新增。真实browser/system、物理PDA时延均未运行。Terra实际0案例仍是独立浏览器控制能力缺口，不称Owner禁用，也未虚构读取Terra Chat。

## 外部新配方读取两份旧的成功冷输入

本环境四个准确source/receipt路径均不存在，故**真实配对测量NOT_RUN**；未运行替代冷构建、未制造真实receipt、未改写旧失败报告。两份原冷输入仍绑定baseline `f282104534f6373423dd42ef6d6b9449613ba96c` 和candidate `e68c604cd1463e4a05efc39b840e4edebbc0f6f0`，其产品字节未因本次helper/config修正改变。

主控从已应用本补丁的R1工作区执行同一新helper，root指向各自原成功冷快照。**不要把新helper/tsconfig复制进冷快照，不要修改任何旧receipt。** 使用新的输出目录和文件；命令见交付README。两个报告须同锁、同工具链、同新recipe，并各自通过原完整sourceManifest/count/hash校验，最后再比较。

原失败测量和单个Web canonical-path诊断继续保留。真实配对报告产生前，不声明字节改善或设备性能。PR15仍待主控验收；全批接受状态仍9/15。PR6/7/8/9/12旧请求和冻结交付未重启/重包。
