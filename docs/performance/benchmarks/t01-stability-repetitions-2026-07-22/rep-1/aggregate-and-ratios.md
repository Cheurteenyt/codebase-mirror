# R179 T01 stability repetition 1 checkpoint

Selected cells: **8**. Selected invalid cells: **0**.

## Aggregates

| Usage | Target | Arm | Raw tokens | Uncached + output | Calls | Response bytes | Query ms | PASS/PARTIAL/FAIL |
|---|---|---|---:|---:|---:|---:|---:|---:|
| continuous | large | B (v2-mcp) | 69,621 | 12,277 | 1 | 6,747 | 15372.8 | 1/0/0 |
| continuous | large | C (grep-read) | 271,521 | 37,793 | 19 | 63,809 | 0.0 | 0/1/0 |
| continuous | small | B (v2-mcp) | 50,360 | 9,144 | 1 | 2,767 | 2873.6 | 1/0/0 |
| continuous | small | C (grep-read) | 198,934 | 25,110 | 8 | 41,880 | 0.0 | 0/0/1 |
| one-shot | large | B (v2-mcp) | 66,864 | 11,568 | 1 | 6,747 | 14354.2 | 1/0/0 |
| one-shot | large | C (grep-read) | 319,234 | 35,842 | 12 | 50,888 | 0.0 | 0/1/0 |
| one-shot | small | B (v2-mcp) | 48,964 | 9,796 | 1 | 2,767 | 3859.4 | 1/0/0 |
| one-shot | small | C (grep-read) | 219,560 | 38,056 | 10 | 39,349 | 0.0 | 1/0/0 |

## Pre-registered ratios

| Usage | Target | V2/V1 tokens | V1/grep tokens | V2/grep tokens | Hybrid/grep tokens | V2/V1 calls | Hybrid/grep calls |
|---|---|---:|---:|---:|---:|---:|---:|
| continuous | large | n/a | n/a | 0.256 | n/a | n/a | n/a |
| continuous | small | n/a | n/a | 0.253 | n/a | n/a | n/a |
| one-shot | large | n/a | n/a | 0.209 | n/a | n/a | n/a |
| one-shot | small | n/a | n/a | 0.223 | n/a | n/a | n/a |
