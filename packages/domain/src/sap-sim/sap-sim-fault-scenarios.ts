import type { SapSimFaultScenarioConfig } from './sim-engine'

/**
 * R1 故障注入场景配置文件（注入点与次数在此；输入是条件，输出由事实推导）。
 *
 * 使用：POST /integrations/sap-sim/faults {scenario_no} 按号激活；
 * 或 POST /integrations/sap-sim/faults 直接提交同构自定义配置。
 * 场景激活后持久化于 sim_sap_fault_scenario（剩余次数/乱序缓冲随命中递减，重启可恢复）。
 */
export const SAP_SIM_FAULT_SCENARIO_CATALOG: readonly SapSimFaultScenarioConfig[] = [
  {
    scenario_no: 'R1-FL-E08-N2-GR-A',
    fault_type: 'RESPONSE_LOST',
    match_event_key: 'CBL01G-EVKEY-MSG-N2-GR-A',
    count: 1,
    description:
      'E08 N2-GR-A：对端已提交但响应丢失——事实先落 sim_sap，回执不返回（TIMEOUT_UNKNOWN）；随后 A1000 原键查询由事实回答',
  },
  {
    scenario_no: 'R1-FL-E08-N2-GR-B',
    fault_type: 'QUERY_UNAVAILABLE',
    match_event_key: 'CBL01G-EVKEY-MSG-N2-GR-B',
    count: 2,
    description:
      'E08 N2-GR-B：查询不可用——B1000 保持 OUTCOME_UNKNOWN，不换键、不当 0、不暗中重试',
  },
  {
    scenario_no: 'R1-FL-MSG-LOST-1',
    fault_type: 'MESSAGE_LOST',
    match_topic: 'MATERIAL_CONSUMPTION',
    count: 1,
    description: '请求未到达：模拟侧不落任何业务事实，仅记到达观察 MESSAGE_LOST',
  },
  {
    scenario_no: 'R1-FL-DELAY-1',
    fault_type: 'DELAY',
    match_topic: 'PRODUCTION_OUTPUT',
    count: 1,
    delay_ms: 50,
    description: '响应延迟：事实正常提交，回执延迟 delay_ms 返回',
  },
  {
    scenario_no: 'R1-FL-DUP-1',
    fault_type: 'DUPLICATE',
    match_topic: 'PRODUCTION_OUTPUT',
    count: 1,
    description: '重复到达：同键重投返回原回执（DUPLICATE_RETURN_ORIGINAL），不产生第二张单据',
  },
  {
    scenario_no: 'R1-FL-REORDER-312',
    fault_type: 'REORDER',
    match_topic: 'EXECUTION_BUNDLE',
    count: 1,
    reorder_keys: null,
    description:
      '乱序：EXECUTION_BUNDLE 到达按 arrival 记录，缓冲后按配置顺序放行（reorder_keys 激活时由调用方传入，≥2 键）',
  },
  {
    scenario_no: 'R1-FL-NET-DOWN-RECOVER',
    fault_type: 'NETWORK_DOWN',
    match_topic: 'MATERIAL_CONSUMPTION',
    count: 1,
    description: '断网→恢复：断网期到达返回 NETWORK_DOWN（可原键补传）；次数耗尽后恢复正常处理',
  },
  {
    scenario_no: 'R1-FL-BIZ-REJECT-REWORK',
    fault_type: 'BUSINESS_REJECT',
    match_topic: 'REWORK_RECLASSIFICATION',
    count: 0,
    description:
      '业务拒绝：模拟侧无返工指令事实时 REWORK_RECLASSIFICATION 被拒（REJECTED_MISSING_REWORK_ORDER；事实缺失即条件，输出由事实推导）',
  },
] as const
