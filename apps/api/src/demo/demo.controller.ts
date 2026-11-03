import { Controller, Get } from '@nestjs/common'
import { CommandResultStatus, ERROR_CODES } from '@cadenza/contracts'
import { Public } from '../auth/decorators'

@Public()
@Controller('demo')
export class DemoController {
  /** GET /demo/contracts —— 回显 contracts 包常量，证明组合根装配跨包依赖。 */
  @Get('contracts')
  contracts(): {
    statuses: string[]
    errorCodes: Record<string, string>
    decimalRule: string
  } {
    return {
      statuses: Object.values(CommandResultStatus),
      errorCodes: { ...ERROR_CODES },
      decimalRule: '数量一律十进制字符串（DecimalString，scale ≤ 4），禁 number',
    }
  }
}
