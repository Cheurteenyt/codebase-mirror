# R177 multi-hop caller correction checkpoint

Selected cells: **4**. Selected invalid cells: **0**.

## Aggregates

| Usage | Target | Arm | Raw tokens | Uncached + output | Calls | Response bytes | Query ms | PASS/PARTIAL/FAIL |
|---|---|---|---:|---:|---:|---:|---:|---:|
| continuous | large | B (v2-mcp) | 69,555 | 12,211 | 1 | 6,708 | 11246.0 | 1/0/0 |
| continuous | small | B (v2-mcp) | 50,912 | 9,696 | 1 | 2,728 | 2974.5 | 1/0/0 |
| one-shot | large | B (v2-mcp) | 83,620 | 12,196 | 1 | 6,708 | 11131.3 | 1/0/0 |
| one-shot | small | B (v2-mcp) | 48,593 | 9,425 | 1 | 2,728 | 3261.2 | 1/0/0 |

## Pre-registered ratios

| Usage | Target | V2/V1 tokens | V1/grep tokens | V2/grep tokens | Hybrid/grep tokens | V2/V1 calls | Hybrid/grep calls |
|---|---|---:|---:|---:|---:|---:|---:|
| continuous | large | n/a | n/a | n/a | n/a | n/a | n/a |
| continuous | small | n/a | n/a | n/a | n/a | n/a | n/a |
| one-shot | large | n/a | n/a | n/a | n/a | n/a | n/a |
| one-shot | small | n/a | n/a | n/a | n/a | n/a | n/a |
