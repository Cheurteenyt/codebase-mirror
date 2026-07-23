---
type: RiskNote
status: active
tags: [delivery, duplicate-receipt]
related_files: [src/delivery/publish.ts]
related_symbols: [commitDelivery]
---

# RISK-004: Duplicate receipts if the retry boundary moves

## HUMAN NOTES

Moving retry behavior into `commitDelivery` can create duplicate receipts and
hide partial durability failures. Preserve one durable write per call, keep the
receipt id stable for an envelope id, and leave retries in `runPipeline`.

### Links to code

- [[commitDelivery]] — `src/delivery/publish.ts`
