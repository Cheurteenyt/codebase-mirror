# R179 T01 stability repetition 2 checkpoint

Selected cells: **8**. Selected invalid cells: **0**.

## Aggregates

| Usage | Target | Arm | Raw tokens | Uncached + output | Calls | Response bytes | Query ms | PASS/PARTIAL/FAIL |
|---|---|---|---:|---:|---:|---:|---:|---:|
| continuous | large | B (v2-mcp) | 69,622 | 18,422 | 1 | 6,747 | 13427.3 | 1/0/0 |
| continuous | large | C (grep-read) | 406,968 | 42,424 | 15 | 61,791 | 0.0 | 0/1/0 |
| continuous | small | B (v2-mcp) | 50,430 | 9,214 | 1 | 2,767 | 2951.5 | 1/0/0 |
| continuous | small | C (grep-read) | 248,368 | 36,144 | 14 | 47,094 | 0.0 | 1/0/0 |
| one-shot | large | B (v2-mcp) | 66,929 | 11,633 | 1 | 6,747 | 10502.1 | 1/0/0 |
| one-shot | large | C (grep-read) | 292,156 | 41,020 | 10 | 84,761 | 0.0 | 0/1/0 |
| one-shot | small | B (v2-mcp) | 48,809 | 9,641 | 1 | 2,767 | 3702.2 | 1/0/0 |
| one-shot | small | C (grep-read) | 159,133 | 22,173 | 8 | 36,684 | 0.0 | 1/0/0 |

## Pre-registered ratios

| Usage | Target | V2/V1 tokens | V1/grep tokens | V2/grep tokens | Hybrid/grep tokens | V2/V1 calls | Hybrid/grep calls |
|---|---|---:|---:|---:|---:|---:|---:|
| continuous | large | n/a | n/a | 0.171 | n/a | n/a | n/a |
| continuous | small | n/a | n/a | 0.203 | n/a | n/a | n/a |
| one-shot | large | n/a | n/a | 0.229 | n/a | n/a | n/a |
| one-shot | small | n/a | n/a | 0.307 | n/a | n/a | n/a |
