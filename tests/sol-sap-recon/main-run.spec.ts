import { it,expect } from 'vitest'
import { finalizeRun } from '../../scripts/sol-sap-recon/finalize-run'
import { verifyBusinessHold } from '../../scripts/sol-sap-recon/business-hold-proof'
import { runMain } from '../../scripts/sol-sap-recon/main-run'
it('prepares original operational input through real MOM commands in one exclusive run',async()=>{
 const session=await runMain()
 try {const final=await finalizeRun(session);expect(final.observed).toHaveLength(65);expect(final.recon).toHaveLength(21);expect(final.recon.filter(row=>row.businessVerdict==='EXPECTED_QUANTITIES_DERIVED')).toHaveLength(19);expect(final.recon.filter(row=>row.businessVerdict==='UNKNOWN_PRESERVED')).toHaveLength(2);expect(final.semantics.filter(row=>row.verdict==='MISMATCH')).toHaveLength(0);await verifyBusinessHold(session,true)} finally {await session.run.close()}
},180000)
