import { Module } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import { ConfigModule } from '@nestjs/config'
import { DbModule } from './db/db.module'
import { AuthModule } from './auth/auth.module'
import { DemoModule } from './demo/demo.module'
import { HealthModule } from './health/health.module'
import { OrgModule } from './org/org.module'
import { MasterDataApiModule } from './masterdata/masterdata.composition'
import { InventoryModule } from './inventory/inventory.module'
import { ProcessApiModule } from './process/process.composition'
import { PurchaseModule } from './purchase/purchase.module'
import { SchedulingApiModule } from './scheduling/scheduling.composition'
import { ExecutionApiModule } from './execution/execution.composition'
import { QualityModule } from './quality/quality.module'
import { WarehousingModule } from './warehousing/warehousing.module'
import { ShippingModule } from './shipping/shipping.module'
import { OtModule } from './ot/ot.module'
import { CswModule } from './csw/csw.module'
import { SpcModule } from './spc/spc.module'
import { CostModule } from './cost/cost.module'
import { ReworkModule } from './rework/rework.module'
import { ConversionModule } from './conversion/conversion.module'
import { ReverseModule } from './reverse/reverse.module'
import { DispositionModule } from './disposition/disposition.module'
import { MaintenanceModule } from './maintenance/maintenance.module'
import { ReportingModule } from './reporting/reporting.module'
import { AiQueryModule } from './aiquery/aiquery.module'
import { IntegrationsApiModule } from './integrations/integrations.composition'
import { GroupModule } from './group/group.module'
import { ProductionModule } from './production/production.module'
import { ScanBlockModule } from './scan-block/scan-block.module'
import { SapModule } from './sap/sap.module'
import { buildImModule } from './aiquery/im/im.composition'
import { imCallbackTokenGuard } from './aiquery/im/im.callback-guard'
import { validateEnv } from './env'
import { AllExceptionsFilter } from './filters/all-exceptions.filter'
import { requestLoggingMiddleware } from './middleware/request-logging'

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    DbModule,
    // AuthModule 注册全局 AuthGuard + ScopeGuard（先会话后范围）
    AuthModule,
    HealthModule,
    DemoModule,
    OrgModule,
    // L0 整合步（Wave3）：主数据（0003）与库存/谱系内核（0004）
    MasterDataApiModule,
    InventoryModule,
    // L0 整合步（Wave4）：工艺与生产订单（0005）、采购主链（0006）
    ProcessApiModule,
    PurchaseModule,
    // L0 整合步（Wave5）：生产排程（0007）、报工/投料执行（0008）、质量放行 + 入库/移库/调拨（0009）
    SchedulingApiModule,
    ExecutionApiModule,
    QualityModule,
    WarehousingModule,
    // L0 整合步（Wave6）：装箱发运（0010）——P1 最后业务域
    ShippingModule,
    // L0 整合步（P3 批次 2026-10-28）：OT 采集（0017）、约束排程与外协（0018）、工艺变更/SPC/校准（0019）、能源成本（0020）
    OtModule,
    CswModule,
    SpcModule,
    CostModule,
    // L0 整合步（P2/P4 批次 2026-10-28）：倒轴分托修正退役（0011）、形态转换（0012）、仓储逆向（0013）、
    // 质量处置（0014）、维保（0015）、报表（0016）、AI 问数（0021）
    ReworkModule,
    ConversionModule,
    ReverseModule,
    DispositionModule,
    MaintenanceModule,
    ReportingModule,
    AiQueryModule,
    // IF-01 料品入站（集成块；模拟 U9_SIM/SAP_SIM）
    IntegrationsApiModule,
    // G 场景：集团分配修订 + 缺料/齐套 + 成品召回 + 供应商风险（≠ cost/投料/CSW/外协）
    GroupModule,
    // E09：投料竞争/计划部分/迟修订（≠ 投料/排程/订单）
    ProductionModule,
    // E09：SCAN-BLOCK 拦截事件（≠ 通用扫码/报工）
    ScanBlockModule,
    SapModule,
    // L0 整合步（P4-C 2026-10-29）：IM 渠道接入子模块挂载（首版组合=mock 双向通道 +
    // 企微/飞书 SITE_PENDING 桩 + 包内存储 + 五接缝 mock 承载；组合根 im.composition.ts；
    // 回调通道鉴权见 configure() imCallbackTokenGuard）
    buildImModule(),
  ],
  providers: [
    // 全局异常过滤器在模块层注册（而非仅 main.ts），保证测试组合与运行时行为一致
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {
  /** 请求日志与 x-request-id（Nest 11 / Express 5 通配路由语法 {*splat}）；
   * L0 整合（P4-C 2026-10-29）：IM 渠道回调通道令牌（env IM_CALLBACK_TOKEN，安全缺省 403） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configure(consumer: any): void {
    consumer
      .apply(requestLoggingMiddleware)
      .forRoutes('{*splat}')
      .apply(imCallbackTokenGuard)
      .forRoutes('aiquery/im/channels/:channelKind/callback')
  }
}
