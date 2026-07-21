# Structural correctness baseline checkpoint

Selected cells: **32**. Selected invalid cells: **0**.

## Aggregates

| Usage | Target | Arm | Raw tokens | Uncached + output | Calls | Response bytes | Query ms | PASS/PARTIAL/FAIL |
|---|---|---|---:|---:|---:|---:|---:|---:|
| continuous | large | B (v2-mcp) | 3,329,913 | 254,585 | 28 | 152,333 | 45782.4 | 3/0/1 |
| continuous | large | C (grep-read) | 2,266,706 | 196,178 | 18 | 97,183 | 0.0 | 2/2/0 |
| continuous | small | B (v2-mcp) | 1,963,616 | 187,232 | 26 | 113,105 | 7490.5 | 2/2/0 |
| continuous | small | C (grep-read) | 2,970,158 | 231,726 | 20 | 741,682 | 0.0 | 3/1/0 |
| one-shot | large | B (v2-mcp) | 1,042,001 | 162,385 | 44 | 200,346 | 58108.4 | 3/0/1 |
| one-shot | large | C (grep-read) | 690,565 | 95,365 | 37 | 162,515 | 0.0 | 4/0/0 |
| one-shot | small | B (v2-mcp) | 917,106 | 96,626 | 32 | 126,106 | 11131.7 | 3/1/0 |
| one-shot | small | C (grep-read) | 366,319 | 82,671 | 17 | 81,219 | 0.0 | 3/0/1 |

## Pre-registered ratios

| Usage | Target | V2/V1 tokens | V1/grep tokens | V2/grep tokens | Hybrid/grep tokens | V2/V1 calls | Hybrid/grep calls |
|---|---|---:|---:|---:|---:|---:|---:|
| continuous | large | n/a | n/a | 1.469 | n/a | n/a | n/a |
| continuous | small | n/a | n/a | 0.661 | n/a | n/a | n/a |
| one-shot | large | n/a | n/a | 1.509 | n/a | n/a | n/a |
| one-shot | small | n/a | n/a | 2.504 | n/a | n/a | n/a |
