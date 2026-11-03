import {it,expect} from 'vitest'
import {runMain} from '../../scripts/sol-sap-recon/main-run'
import {remainingS5} from '../../scripts/sol-sap-recon/remaining-s5'
it('executes remaining independent S5 decisions without mutating the same-run main ledger',async()=>{
 const session=await runMain()
 try{const result=await remainingS5(session);expect(result.mainLedgerUnchanged).toBe(true)}finally{await session.run.close()}
},180000)
