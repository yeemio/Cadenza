/**
 * 字典装载：按域组织，合并为单表查找（源串全局唯一键；跨域共享串归 common）。
 * zh-CN 恒等（运行时不查表，导出仅供覆盖审计）；ko-KR 为韩文工作稿。
 */
import { zh_common } from './zh-CN/common'
import { zh_org } from './zh-CN/org'
import { zh_masterdata } from './zh-CN/masterdata'
import { zh_inventory } from './zh-CN/inventory'
import { zh_process } from './zh-CN/process'
import { zh_scheduling } from './zh-CN/scheduling'
import { zh_execution } from './zh-CN/execution'
import { zh_purchase } from './zh-CN/purchase'
import { zh_quality } from './zh-CN/quality'
import { zh_warehousing } from './zh-CN/warehousing'
import { zh_shipping } from './zh-CN/shipping'
import { zh_rework } from './zh-CN/rework'
import { zh_conversion } from './zh-CN/conversion'
import { zh_reverse } from './zh-CN/reverse'
import { zh_disposition } from './zh-CN/disposition'
import { zh_maintenance } from './zh-CN/maintenance'
import { zh_reporting } from './zh-CN/reporting'
import { zh_ot } from './zh-CN/ot'
import { zh_csw } from './zh-CN/csw'
import { zh_spc } from './zh-CN/spc'
import { zh_cost } from './zh-CN/cost'
import { zh_aiquery } from './zh-CN/aiquery'
import { ko_common } from './ko-KR/common'
import { ko_org } from './ko-KR/org'
import { ko_masterdata } from './ko-KR/masterdata'
import { ko_inventory } from './ko-KR/inventory'
import { ko_process } from './ko-KR/process'
import { ko_scheduling } from './ko-KR/scheduling'
import { ko_execution } from './ko-KR/execution'
import { ko_purchase } from './ko-KR/purchase'
import { ko_quality } from './ko-KR/quality'
import { ko_warehousing } from './ko-KR/warehousing'
import { ko_shipping } from './ko-KR/shipping'
import { ko_rework } from './ko-KR/rework'
import { ko_conversion } from './ko-KR/conversion'
import { ko_reverse } from './ko-KR/reverse'
import { ko_disposition } from './ko-KR/disposition'
import { ko_maintenance } from './ko-KR/maintenance'
import { ko_reporting } from './ko-KR/reporting'
import { ko_ot } from './ko-KR/ot'
import { ko_csw } from './ko-KR/csw'
import { ko_spc } from './ko-KR/spc'
import { ko_cost } from './ko-KR/cost'
import { ko_aiquery } from './ko-KR/aiquery'

export const ZH_CN_DICTIONARY: Record<string, string> = {
  ...zh_common,
  ...zh_org,
  ...zh_masterdata,
  ...zh_inventory,
  ...zh_process,
  ...zh_scheduling,
  ...zh_execution,
  ...zh_purchase,
  ...zh_quality,
  ...zh_warehousing,
  ...zh_shipping,
  ...zh_rework,
  ...zh_conversion,
  ...zh_reverse,
  ...zh_disposition,
  ...zh_maintenance,
  ...zh_reporting,
  ...zh_ot,
  ...zh_csw,
  ...zh_spc,
  ...zh_cost,
  ...zh_aiquery,
}

export const KO_KR_DICTIONARY: Record<string, string> = {
  ...ko_common,
  ...ko_org,
  ...ko_masterdata,
  ...ko_inventory,
  ...ko_process,
  ...ko_scheduling,
  ...ko_execution,
  ...ko_purchase,
  ...ko_quality,
  ...ko_warehousing,
  ...ko_shipping,
  ...ko_rework,
  ...ko_conversion,
  ...ko_reverse,
  ...ko_disposition,
  ...ko_maintenance,
  ...ko_reporting,
  ...ko_ot,
  ...ko_csw,
  ...ko_spc,
  ...ko_cost,
  ...ko_aiquery,
}

import type { Locale } from '../types'

/** 当前语言查找：zh-CN 恒等；ko-KR 查合并字典，缺译回退源串 */
export function translateWith(locale: Locale, source: string): string {
  if (locale === 'ko-KR') return KO_KR_DICTIONARY[source] ?? source
  return source
}
