import { ERROR_CODES } from '@cadenza/contracts'
import { getGlobalLocale } from '../i18n/global'
import { t } from '../i18n/translate'
import { ERROR_MESSAGES_KO, NETWORK_ERROR_KO, RULE_MESSAGES_KO, UNKNOWN_ERROR_KO } from './errorMessages.ko'

/**
 * 错误资源集中管理、中文首发（PC-15）。
 * 同一次失败只展示一个主错误及可行动指引（PC-14）：
 * message 为主文案，服务端原始 message 并入 detail 供排查。
 */

export const ERROR_MESSAGES_ZH: Record<string, string> = {
  [ERROR_CODES.AUTH_REQUIRED]: '请先登录：会话缺失或已过期，请重新登录',
  [ERROR_CODES.FORBIDDEN_SCOPE]: '没有该操作的数据范围权限，请联系管理员调整授权',
  [ERROR_CODES.NOT_FOUND]: '请求的对象不存在或已被删除',
  [ERROR_CODES.VERSION_CONFLICT]: '数据已被他人修改（版本冲突），请刷新后重试',
  [ERROR_CODES.IDEMPOTENT_PAYLOAD_MISMATCH]:
    '该操作号已提交过且内容不一致，请勿用同一操作号重复提交不同内容',
  [ERROR_CODES.INSUFFICIENT_STOCK]: '库存不足，无法完成本次出库',
  [ERROR_CODES.BUSINESS_RULE]: '业务规则校验未通过，请检查输入内容',
}

/** 网络/协议层通用文案（非合同错误码场景） */
export const NETWORK_ERROR_ZH = '无法连接服务器，请检查网络后重试'
export const UNKNOWN_ERROR_ZH = '操作失败，请稍后重试或联系管理员'

/** 错误码 → 主文案（按当前语言选择 zh/ko 表；未知码回退通用文案） */
export function errorText(code: string | undefined | null): string {
  const table = getGlobalLocale() === 'ko-KR' ? ERROR_MESSAGES_KO : ERROR_MESSAGES_ZH
  const fallback = getGlobalLocale() === 'ko-KR' ? UNKNOWN_ERROR_KO : UNKNOWN_ERROR_ZH
  if (code && table[code]) return table[code]
  return fallback
}

/** 网络/协议层通用文案（按当前语言） */
export function networkErrorText(): string {
  return getGlobalLocale() === 'ko-KR' ? NETWORK_ERROR_KO : NETWORK_ERROR_ZH
}

/** 规则码 → 主文案（zh/ko 双表；ko 缺译回退 zh，PC-14 可行动指引不缺位） */
export function ruleText(rule: string): string | undefined {
  if (getGlobalLocale() === 'ko-KR' && RULE_MESSAGES_KO[rule]) return RULE_MESSAGES_KO[rule]
  return RULE_MESSAGES_ZH[rule]
}

/**
 * 业务规则码中文映射（第三波 MD/IT + 第四波 A3/A5/A6/A7/A-T12/A-T13）：
 * 平台错误码仅 7 个（ERROR_CODES）；域规则违例统一以 ERR_BUSINESS_RULE +
 * message 携带 `[MD-xx]`/`[IT-xx]`/`[OA-xx]`/`[A3-xx]`/`[A5-xx]`/`[A6-xx]`/`[A7-xx]`/
 * `[A-T12-x]`/`[A-T13-x]` 规则号返回（domain RuleViolation → violationOutcome 口径）。
 * 本表按规则号给出可行动中文主文案；服务端原始 message 仍并入 detail（PC-14）。
 * 仅收录冻结合同/底稿已裁定的规则；未列规则号回退 errorText。
 */
export const RULE_MESSAGES_ZH: Record<string, string> = {
  // master-data.md（MD-01～MD-37）
  'MD-01': '料品主数据由 U9/ERP 同步维护，本系统只读（仅换算行可编辑）',
  'MD-02': '料品主档字段（含是否质检）同步后不可在本系统修改',
  'MD-03': '料品编号在同组织内必须唯一',
  'MD-04': '换算数量须为非负数字（整数≤9 位、小数≤4 位），单位名必填且≤100 字符',
  'MD-05': '换算行已被采购收货引用，不可修改或删除；如需变更请生成新版本',
  'MD-09': '设备编码/名称全局唯一；名称最长 50 字符',
  'MD-10': '设备所属部门必须与其所属工作中心的部门一致，请先核对后重选',
  'MD-11': '设备已被排产或报工引用，不可删除',
  'MD-13': '设备状态仅支持：1=正常、2=维修',
  'MD-14': '设备状态变更须记录流水（来源 WEB/PDA），请使用状态变更入口',
  'MD-15': '设备编码不得自带 EQU- 前缀（设备码由系统按 EQU-+编码 生成）',
  'MD-16': '设备产能须为十进制数字（整数≤10 位、小数≤4 位）',
  'MD-17': '工作中心编码全局唯一；同部门内名称唯一',
  'MD-18': '工作中心被设备/工序/订单工序引用，不可删除',
  'MD-22': '仓库编码必须为 4 位数字；仓库名称必填且最长 20 字符、全局唯一',
  'MD-23': '仓库类型限定可收料品类型（仓库→原料/成品；线边仓→原料/半成品/成品），且至少配置一种',
  'MD-24': '该部门类型仅允许创建特定仓库类型（物流部→仓库；车间→线边仓），请调整部门或仓库类型',
  'MD-25': '该仓库下已有普通库位，不允许修改仓库编码',
  'MD-26': '仓库已被二维码占用，不允许修改类型/料品类型，不可删除',
  'MD-27': '仓库存在库存余额或流水引用，不可删除',
  'MD-28': '普通库位编码必须为 8 位数字（仓库码 4 位＋库位码 4 位），前缀须匹配所属仓库且同工厂内唯一',
  'MD-29': '库位已被二维码占用，不允许修改库位编码或删除',
  'MD-30': '货架编号必须为 2 位数字，同工厂内唯一',
  'MD-31': '货架区域数/层数须为 1–99；层数与区域数编辑时不可修改',
  'MD-33': '货架下存在被二维码占用的库位或库存引用，不可删除',
  'MD-36': '主数据删除为逻辑失效（历史引用保持可解析）',
  'MD-37': '该主数据已被库存余额或库存流水引用，拒绝退役/删除',
  // inventory-trace-core.md（命令链路可surface的 IT 规则）
  'IT-01': '库存对象身份不可覆盖历史：单元号/批次绑定唯一，标签补打须引用原标签',
  'IT-02': '库存的所有者、保管工厂、所在库位均不得为空',
  'IT-04': '条码未解析到候选对象，请核对条码或改用人工输入',
  'IT-07': '数量必须为正的十进制定点字符串（禁用浮点）',
  'IT-08': '数量四元组不完整或非法（数量/单位/计量基准）',
  'IT-14': '可用量不足：可用量=质量合格∧未被预留占用，请核对该单元的预留后再操作',
  'IT-19': '流水数量必须为十进制定点字符串，且变动量不得为 0',
  'IT-23': '预留参数不完整或非法：须含占用者、对象、正数量与晚于当前的有效期',
  'IT-30': '余量不足会导致负库存，已被拒绝；请刷新余额后重试（重试请换新操作号）',
  'IT-31': '扣数操作必须记录原因与去向',
  'IT-37': '业务时间缺失或非法（须为 ISO-8601，与系统时间分列）',
  // 03-production-chain-rules.md A3（排程 T09）
  'A3-1': '排产槽位需要订单工序/设备/生产日期/计划数量（同键替换；计划量改 0 = 删槽）',
  'A3-2': '槽位计划量合计已超过工序下线数量（硬校验，不可通过确认提交）',
  'A3-2w': '超出设备日产能——弱提醒：确认后请携带「确认提交」重新提交（confirm=true）',
  'A3-3': '维修中的设备不可排产（设备状态须为正常）',
  'A3-5': '已结束/已作废订单不出现在设备看板',
  'A3-6': '订单排程前置未通过：工序已配置且各工序均已配置工作中心后才能排产',
  'A4-1': '班次参数（白班起点）为工厂级唯一配置',
  'A4-2': '班次日期双轨：实际时间与业务班次日期并存（跨零点班次归前一班）',
  // 03-production-chain-rules.md A5/A6（五量与报工 T10）
  'A5-1': '超产硬限：末道工序报产合计不得超过 计划数量×(1+超额比例)',
  'A5-2': '产出单位必须与订单生产单位一致（件数/盘数与长度/重量不可互相覆盖）',
  'A5-3': '五量分立口径（草稿/提交/审核/合格/入库），不提供混口径「完成数量」',
  'A6-1': '报工三入口（订单/工作台/扫码）同规则：已作废订单或无排产工序不可报工',
  'A6-2': '已有产出（或投料）的草稿工序不可更改，请续作或新建',
  'A6-3': '非进行中或挂起中的订单不可报工；质检工序一律不可选',
  'A6-5': '产出行必填（数量+单位+载体码+目标库位）；产出只能转入线边库',
  'A6-6': '待审单仅允许修改产出数量/合格数（行数与载体码不可改）；产出已入库即不可撤审/删除',
  // 03-production-chain-rules.md A7（投料 T11）
  'A7-1': '投料须订单进行中且未挂起；工序单选、质检工序不可选（[A7-1/K03] 联合口径）',
  'A7-1/K03': '投料须订单进行中且未挂起（统一归属、部门、可开工、非质检四检）',
  'A7-2': '投料码准入链：仅产品轴码（10 位第 2 位 E/F/M）→档案→销售归属→质量准入→在库→线边库→可消耗→非本工序产出→本订单前道产出→余量>0',
  'A7-3': '跨订单投料须显式确认并记录偏离原因（一次确认不是充分授权）',
  'A7-4': '按销售行汇总本次投料不得超过剩余可投量；提交事务内实时校验并扣减（记扣前/扣后）',
  // 04-supply-chain-rules.md A-T12（质量放行）
  'A-T12-1': '质量状态轴处置：放行/让步——让步保留原不合格事实（based_on_version 引用原结论）',
  'A-T12-2': '隔离与处置相互独立：待检/不合格/存疑隔离中的库存不可用',
  'A-T12-3': '存疑登记须在库且在库位且未存疑（托码拒绝）；恢复必须填写处置依据',
  'A-T12-4': '质量闸门：可用量=质量合格∧未被预留占用',
  'A-T12-5': '检验任务来源（报工/入库）幂等生成；检验规范引用版本化',
  // 04-supply-chain-rules.md A-T13（入库/移库/调拨）
  'A-T13-1': '待入库任务由报工/成品质检异步写入台账，禁止手工增删改（只能刷新重跑）',
  'A-T13-2': '托码确认＝整托入库：同托全部未入库任务一并完成',
  'A-T13-4': '移库校验：同仓内库位移动、原/新库位不得相同、托下单码禁扫（移库只可整托）',
  'A-T13-6': '调拨仓库规则：调入仓库不得等于调出仓库，且须满足仓库类型约束',
  'A-T13-7': '仅在库码可调拨出库：被其它业务锁定、剩余数量不足或仓库不匹配均拒绝',
  'A-T13-10': '调拨状态机：草稿→待执行→出库中→已出库在途→收货中→完成（两段事实 out/in）',
  'A-T13-11': '调拨锁定（作业预留）必须含有效期且晚于当前时间；过期后重新提交须重校验',
  // 04-supply-chain-rules.md A-T14（装箱发运 T14）
  'A-T14-1': 'PL 状态机：待装箱→待出库→已出库（单向不可逆）；载荷须含发货单号与至少一行备货行',
  'A-T14-2': '销售订单行缺 DC 分段/组成数据，已标记 compositionMissing（生产订单行标黄数据源）',
  'A-T14-3': '扫码装入五拒：未审核/质量存疑/被锁定/未关联销售订单行/无段长均拒收；重复装入与超扫亦拒；行扫满→已装箱',
  'A-T14-4': '打包任务：先扫托码+选调入库位，逐行扫满后绑定托码；已打包托码与库位只读',
  'A-T14-5': '补码仅适用于无轴单品行（缺产品轴号补登记，计入已扫件数且受应扫上限约束）',
  'A-T14-7': '确认出库仅可自待出库执行；存在已扫<应扫的备货行时拒绝（指名料品/段长）',
  'A-T14-8': '实发轴与发货状态两条回传相互独立：实发轴无差异=无需同步（不是失败）；重试不重做已成功侧',
  'A-T14-10': '装箱图附件至少一张；部分失败时保留已成功张（逐张校验）',
  // interfaces.md IF（入站/回传通道；shipping 命令面可 surface）
  'IF-00.2': '外部报文按业务键幂等：重复报文幂等返回，不重复应用',
  'IF-00.3': '外部修订号低于已应用修订（stale 报文不覆盖）',
  'IF-00.6': '回传载荷固化为出库完成时点快照：重试按快照重推，不得改推当前值',
  'IF-00.8': '缺组织映射：报文已写入隔离队列（QUARANTINED），待人工补绑后重新下发',
  'IF-04': 'DC 分段/组成入站：dcId+销售订单号+行号为幂等键；行号须为正整数',
  'IF-05': 'PL 入站：发货单号幂等；三类行（托盘/有轴/无轴）规格断言未通过',
  'IF-06': '实发轴同步仅已出库发货单参与；已成功侧（synced/无需同步）不重做',
  'IF-07': '发货状态同步仅已出库发货单参与；已成功侧不重做',
  // 厂级隔离/数据范围（排产与四域写路径二道防线）
  'NEW-1': '目标对象与订单/工厂不在同一工厂（厂级隔离），请核对归属',
  'D4': '操作工仅自己参与报工/投料；代他人操作须持 execution.review 许可',
  'A-S1': '目标工厂不在授权数据范围内，请联系管理员调整授权',
}

/**
 * 从服务端 message 提取规则号：
 * 覆盖 `[MD-24]`/`[IT-14]`/`[OA-10]`、生产链 `[A3-2w]`/`[A6-5]`/`[A7-2]`、
 * 供应链 `[A-T12-5]`/`[A-T13-4]`/`[A-T14-3]`、接口通道 `[IF-00.8]`/`[IF-04]`
 * 与复合 `[A7-1/K03]`；无则 null。
 */
export function ruleCodeOf(message: string | undefined | null): string | null {
  if (!message) return null
  const m = /\[((?:MD|IT|OA)-\d+|A-T1[234]-\d+|IF-\d{2}(?:\.\d+)?|A\d-\d+[a-z]?)(?:\/[A-Z0-9a-z.-]+)?\]/.exec(message)
  return m ? m[0].slice(1, -1) : null
}

/**
 * 组装 PC-14 口径的错误展示：
 * 主文案（可行动指引）+ 保留服务端 detail / requestId 供排查。
 */
export function formatErrorTitleAndDetail(err: {
  code?: string
  message?: string
  requestId?: string
}): { title: string; detail?: string } {
  // 规则码优先：message 携带 [MD-xx]/[IT-xx]/[OA-xx] 且本表已收录时，主文案换为该规则的可行动指引
  const rule = ruleCodeOf(err.message)
  const title = (rule !== null && ruleText(rule)) || errorText(err.code)
  const parts: string[] = []
  if (err.message && err.message !== title) parts.push(err.message)
  if (err.requestId) parts.push(t('请求标识：{p0}', { p0: err.requestId }))
  return { title, detail: parts.length > 0 ? parts.join('；') : undefined }
}
