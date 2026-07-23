---
type: ADR
status: active
tags: [delivery, durability, retry]
related_files: [src/delivery/publish.ts, src/orchestration/pipeline.ts]
related_symbols: [commitDelivery, runPipeline]
---

# ADR-007: Keep retries outside the durable write

## HUMAN NOTES

### Context

The orchestration layer may retry a pipeline after a transient failure. A retry
inside the durable write would make a single orchestration attempt produce
multiple receipts.

### Decision

`commitDelivery` performs exactly one durable write per call and remains
idempotent for the envelope id. `runPipeline` owns retry policy and backoff.

### Links to code

- [[commitDelivery]] — `src/delivery/publish.ts`
- [[runPipeline]] — `src/orchestration/pipeline.ts`
