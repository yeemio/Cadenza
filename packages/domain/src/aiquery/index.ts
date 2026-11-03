/**
 * aiquery 域（P4-A 受控问数查询层）：能力定义 seed（AQ-REG-02/03）、许可键（AQ-AUTH-02）、
 * 输入解析与口径纯规则（AQ-AMB-01～03、GAP-P4）、§8 未就绪问法族、七状态值域。
 *
 * 注意：本目录未加入 domain/src/index.ts 导出（共享文件不改动，L0 整合步统一导出）；
 * application 消费方以 dist 相对导入桥接（先例：shipping/quality 跨子域消费），
 * L0 整合后改包名导入。
 */
export * from './errors'
export * from './permissions'
export * from './capabilities'
export * from './rules'
