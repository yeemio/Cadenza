# PR15-SYSTEM-UI-20261104-R1

结果：五条指定流程执行完毕，其中 4 PASS、1 FAIL。PDA 未登录页面没有可见语言切换控件；这不是 PR15 工程 ACCEPT。上一次旧 data 错误页的阻塞记录保存在 `R1-first-attempt.md`。

## 候选和运行时绑定

`PR15-SYSTEM-UI-R1-SERVICES.json` 记录 source `e68c604cd1463e4a05efc39b840e4edebbc0f6f0`、19 文件 fingerprint `811cc44d9f4d968f2273f6240f3576a974a3d733aa735bbff264cb04816bfc7c`、cold artifact aggregate `cd3f6119b97dd6148dfbd3c144e7a75890fc797044b395b7eaec4aa9fbe01f4b`。服务清单记录 API/Web/PDA 的 PID 分别为 33177/33178/33179，端口为 3001/5173/5174；本次复核了清单内容和实际页面 URL，未独立复算源码、产物或 PID 归属。Browser 客户端为本线程 `iab` browser ID 2，实际 Web/PDA 使用的新 tab ID 3。

## 五条流程

1. **PASS — Web 未登录跳转。** 新标签直接打开 `http://127.0.0.1:5173/inventory/units` 后，标签元数据和页面可访问性树显示 `http://127.0.0.1:5173/login`，登录表单实际显示。证据：`web-anonymous-login.ax.txt`。
2. **PASS — Web 合成管理员登录及返回目标。** 通过页面正常表单登录，实际返回 `http://127.0.0.1:5173/inventory/units`；可见“单元详情”和主导航，未见页面上的 chunk 加载错误提示。页面提示该角色缺少 `inventory.read`，所以没有验证库存数据查询。未检查控制台或网络日志。证据：`web-inventory.ax.txt`。
3. **PASS — 两个 Web 路由的受限分支渲染。** `http://127.0.0.1:5173/p2/quality/suspect` 显示“质量存疑”和主导航，提示缺少 `disposition.read`；`http://127.0.0.1:5173/spc/calibration` 显示“计量校准”和主导航，提示缺少 `spc.read`。这证明目标页面和授权提示分支渲染，不证明受保护的数据查询。证据：`web-quality-suspect.ax.txt`、`web-calibration-zh.ax.txt`。
4. **PASS — Web 中韩切换。** 在校准页面从简体中文切至 한국어 后，页面标题、导航及权限提示显示韩文；切回简体中文后页面和导航仍显示。证据：`web-calibration-ko.ax.txt`、`web-calibration-zh.ax.txt`。
5. **FAIL — PDA 登录页语言切换。** 访问 `http://127.0.0.1:5174/scan` 后实际进入 `http://127.0.0.1:5174/login`，登录标题、账号和密码字段及登录按钮已渲染；可访问性树与页面截图均未显示语言切换控件，因而无法执行所要求的 PDA 语言切换。没有尝试 PDA 登录或扫码。证据：`pda-login.ax.txt`、`pda-login.png`。

真实物理 PDA、设备速度和包体测量：NOT_RUN。本次未提交业务数据、变更账户或权限，也未修改产品源码、测试、迁移或配置。标签页已标记 handoff；仅记录本次 UI 观察，不替代仍待完成的作者测量/types 返工及主控验收。
