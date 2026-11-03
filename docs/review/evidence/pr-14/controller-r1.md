# Controller PR14 R1 acceptance

**ACCEPT — scoped I17 simulated-gateway source fix.** Received the original Chat's exact R1 increment `b4d41654e790b07c66bbaeea68ed87c5d3ed22f15a3fdbfc36b448fd69219110` against parent `624067da1a5340a107db4c7786fc7755a572e1ed`. The controller applied it without rewriting product/test code, then added this acceptance evidence.

Fresh reception: revised legacy edge suite 6 executed, 6 passed, 0 failed/skipped; edge typecheck exit0. All four R0 source/test hashes are unchanged. Reuse R0's seven source cases and targeted contracts/domain/edge build; these are valid old results, not new runs. Original R0 failure output remains intact.

The final cases explicitly retain data and overflow with no transport or offline transport, require an acknowledged MemoryTransport batch before removal, and retain restart sequence/backlog assertions. Concurrent arrivals, missing/rejected acknowledgments, file checkpoints and same-ID replay are covered by the unchanged seven-case gate.

This accepts local source/simulated-gateway behavior only. Real API/PG, hardware, field operation, power-loss fsync/corrupt checkpoints and independent R6 remain unverified. Publication and readiness do not authorize main merge or deployment. The remaining fourteen PRs remain under the same original Chat batch authority.
