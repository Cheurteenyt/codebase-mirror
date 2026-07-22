# R178 fresh V2 MCP versus grep/read multi-hop checkpoint

Selected cells: **8**. Selected invalid cells: **0**.

## Aggregates

| Usage | Target | Arm | Raw tokens | Uncached + output | Calls | Response bytes | Query ms | PASS/PARTIAL/FAIL |
|---|---|---|---:|---:|---:|---:|---:|---:|
| continuous | large | B (v2-mcp) | 69,691 | 12,347 | 1 | 6,747 | 13693.4 | 1/0/0 |
| continuous | large | C (grep-read) | 273,808 | 28,816 | 10 | 62,774 | 0.0 | 0/1/0 |
| continuous | small | B (v2-mcp) | 50,871 | 14,775 | 1 | 2,767 | 4078.7 | 1/0/0 |
| continuous | small | C (grep-read) | 361,041 | 51,537 | 21 | 45,200 | 0.0 | 0/0/1 |
| one-shot | large | B (v2-mcp) | 67,075 | 11,779 | 1 | 6,747 | 13315.1 | 1/0/0 |
| one-shot | large | C (grep-read) | 391,993 | 45,369 | 13 | 88,373 | 0.0 | 0/1/0 |
| one-shot | small | B (v2-mcp) | 49,200 | 10,032 | 1 | 2,767 | 4034.1 | 1/0/0 |
| one-shot | small | C (grep-read) | 196,753 | 28,049 | 8 | 46,755 | 0.0 | 0/0/1 |

## Pre-registered ratios

| Usage | Target | V2/V1 tokens | V1/grep tokens | V2/grep tokens | Hybrid/grep tokens | V2/V1 calls | Hybrid/grep calls |
|---|---|---:|---:|---:|---:|---:|---:|
| continuous | large | n/a | n/a | 0.255 | n/a | n/a | n/a |
| continuous | small | n/a | n/a | 0.141 | n/a | n/a | n/a |
| one-shot | large | n/a | n/a | 0.171 | n/a | n/a | n/a |
| one-shot | small | n/a | n/a | 0.250 | n/a | n/a | n/a |
