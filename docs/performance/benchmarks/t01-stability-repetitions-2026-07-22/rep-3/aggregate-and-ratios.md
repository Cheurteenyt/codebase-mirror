# R179 T01 stability repetition 3 checkpoint

Selected cells: **8**. Selected invalid cells: **0**.

## Aggregates

| Usage | Target | Arm | Raw tokens | Uncached + output | Calls | Response bytes | Query ms | PASS/PARTIAL/FAIL |
|---|---|---|---:|---:|---:|---:|---:|---:|
| continuous | large | B (v2-mcp) | 68,387 | 11,043 | 1 | 6,747 | 12949.3 | 1/0/0 |
| continuous | large | C (grep-read) | 314,177 | 58,177 | 11 | 66,569 | 0.0 | 0/1/0 |
| continuous | small | B (v2-mcp) | 41,888 | 6,816 | 1 | 2,767 | 2876.6 | 1/0/0 |
| continuous | small | C (grep-read) | 348,779 | 34,667 | 16 | 32,968 | 0.0 | 0/0/1 |
| one-shot | large | B (v2-mcp) | 66,595 | 11,299 | 1 | 6,747 | 11881.8 | 1/0/0 |
| one-shot | large | C (grep-read) | 385,898 | 52,586 | 13 | 76,372 | 0.0 | 1/0/0 |
| one-shot | small | B (v2-mcp) | 49,383 | 10,215 | 1 | 2,767 | 3099.2 | 1/0/0 |
| one-shot | small | C (grep-read) | 181,594 | 24,154 | 8 | 35,374 | 0.0 | 1/0/0 |

## Pre-registered ratios

| Usage | Target | V2/V1 tokens | V1/grep tokens | V2/grep tokens | Hybrid/grep tokens | V2/V1 calls | Hybrid/grep calls |
|---|---|---:|---:|---:|---:|---:|---:|
| continuous | large | n/a | n/a | 0.218 | n/a | n/a | n/a |
| continuous | small | n/a | n/a | 0.120 | n/a | n/a | n/a |
| one-shot | large | n/a | n/a | 0.173 | n/a | n/a | n/a |
| one-shot | small | n/a | n/a | 0.272 | n/a | n/a | n/a |
