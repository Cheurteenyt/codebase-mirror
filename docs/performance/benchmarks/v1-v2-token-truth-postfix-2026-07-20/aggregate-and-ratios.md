# V1/V2 token-truth postfix checkpoint

Selected cells: **192**. Selected invalid cells: **0**.

## Aggregates

| Usage | Target | Arm | Raw tokens | Uncached + output | Calls | Response bytes | Query ms | PASS/PARTIAL/FAIL |
|---|---|---|---:|---:|---:|---:|---:|---:|
| continuous | large | A (v1-mcp) | 12,924,301 | 953,229 | 86 | 1,645,708 | 8885.7 | 9/2/1 |
| continuous | large | B (v2-mcp) | 5,631,799 | 496,695 | 33 | 59,044 | 224989.3 | 11/0/1 |
| continuous | large | C (grep-read) | 3,153,561 | 332,697 | 16 | 200,543 | 0.0 | 11/0/1 |
| continuous | large | D (hybrid) | 3,350,973 | 343,997 | 17 | 24,412 | 0.0 | 11/0/1 |
| continuous | small | A (v1-mcp) | 13,896,174 | 1,053,166 | 215 | 2,844,789 | 26787.5 | 12/0/0 |
| continuous | small | B (v2-mcp) | 5,126,300 | 513,436 | 16 | 44,178 | 8142.1 | 12/0/0 |
| continuous | small | C (grep-read) | 3,294,208 | 359,936 | 19 | 48,717 | 0.0 | 12/0/0 |
| continuous | small | D (hybrid) | 3,100,999 | 360,007 | 18 | 34,287 | 0.0 | 12/0/0 |
| one-shot | large | A (v1-mcp) | 1,840,281 | 281,497 | 157 | 632,208 | 18150.8 | 9/2/1 |
| one-shot | large | B (v2-mcp) | 776,437 | 111,093 | 28 | 73,964 | 56163.2 | 11/0/1 |
| one-shot | large | C (grep-read) | 580,016 | 105,904 | 24 | 123,160 | 0.0 | 11/0/1 |
| one-shot | large | D (hybrid) | 465,127 | 79,079 | 20 | 218,507 | 0.0 | 10/1/1 |
| one-shot | small | A (v1-mcp) | 2,427,053 | 361,389 | 154 | 806,681 | 9515.6 | 11/1/0 |
| one-shot | small | B (v2-mcp) | 762,641 | 144,145 | 31 | 73,018 | 9297.7 | 12/0/0 |
| one-shot | small | C (grep-read) | 571,498 | 121,962 | 27 | 72,896 | 0.0 | 12/0/0 |
| one-shot | small | D (hybrid) | 630,738 | 136,658 | 26 | 134,597 | 0.0 | 12/0/0 |

## Pre-registered ratios

| Usage | Target | V2/V1 tokens | V1/grep tokens | V2/grep tokens | Hybrid/grep tokens | V2/V1 calls | Hybrid/grep calls |
|---|---|---:|---:|---:|---:|---:|---:|
| continuous | large | 0.436 | 4.098 | 1.786 | 1.063 | 0.384 | 1.063 |
| continuous | small | 0.369 | 4.218 | 1.556 | 0.941 | 0.074 | 0.947 |
| one-shot | large | 0.422 | 3.173 | 1.339 | 0.802 | 0.178 | 0.833 |
| one-shot | small | 0.314 | 4.247 | 1.334 | 1.104 | 0.201 | 0.963 |
