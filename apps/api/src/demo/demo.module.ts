import { Module } from '@nestjs/common'
import { DemoController } from './demo.controller'

/** demo 模块：证明跨包装配（api → @cadenza/contracts）真实生效。 */
@Module({
  controllers: [DemoController],
})
export class DemoModule {}
