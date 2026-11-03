import {it} from 'vitest'
import {runMain} from '../../scripts/sol-sap-recon/main-run'
import {verifyBusinessHold} from '../../scripts/sol-sap-recon/business-hold-proof'
it('keeps four qualified axes unavailable and rejects real downstream commits without quantity or shipping changes',async()=>{
 const session=await runMain()
 try{await verifyBusinessHold(session)}finally{await session.run.close()}
},180000)
