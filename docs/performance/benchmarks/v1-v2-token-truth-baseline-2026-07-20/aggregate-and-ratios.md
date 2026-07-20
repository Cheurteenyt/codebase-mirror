# V1/V2 token-truth baseline checkpoint

Selected cells: **192**. Selected invalid cells: **3**.

## Aggregates

| Usage | Target | Arm | Raw tokens | Uncached + output | Calls | Response bytes | Query ms | PASS/PARTIAL/FAIL |
|---|---|---|---:|---:|---:|---:|---:|---:|
| continuous | large | A (v1-mcp) | 10,769,027 | 632,195 | 117 | 337,876 | 12330.2 | 9/2/1 |
| continuous | large | B (v2-mcp) | 8,492,285 | 705,789 | 49 | 246,739 | 62077.8 | 10/0/2 |
| continuous | large | C (grep-read) | 3,458,487 | 344,759 | 19 | 66,648 | 0.0 | 10/1/1 |
| continuous | large | D (hybrid) | 3,274,293 | 408,885 | 18 | 35,133 | 0.0 | 10/1/1 |
| continuous | small | A (v1-mcp) | 18,258,502 | 1,176,646 | 294 | 4,243,655 | 11348.0 | 12/0/0 |
| continuous | small | B (v2-mcp) | 5,411,852 | 587,276 | 25 | 113,876 | 14837.6 | 12/0/0 |
| continuous | small | C (grep-read) | 4,054,555 | 383,515 | 20 | 66,944 | 0.0 | 12/0/0 |
| continuous | small | D (hybrid) | 3,367,281 | 383,089 | 19 | 37,676 | 0.0 | 12/0/0 |
| one-shot | large | A (v1-mcp) | 1,809,874 | 276,946 | 146 | 402,424 | 15939.8 | 9/2/1 |
| one-shot | large | B (v2-mcp) | 1,363,515 | 200,507 | 109 | 1,031,390 | 68894.3 | 10/1/1 |
| one-shot | large | C (grep-read) | 792,453 | 146,565 | 29 | 318,947 | 0.0 | 10/1/1 |
| one-shot | large | D (hybrid) | 566,927 | 112,271 | 20 | 280,279 | 0.0 | 10/1/1 |
| one-shot | small | A (v1-mcp) | 2,383,672 | 353,848 | 142 | 1,089,704 | 7425.2 | 10/1/1 |
| one-shot | small | B (v2-mcp) | 1,186,699 | 236,683 | 100 | 2,509,357 | 17094.0 | 12/0/0 |
| one-shot | small | C (grep-read) | 505,583 | 141,295 | 23 | 67,645 | 0.0 | 12/0/0 |
| one-shot | small | D (hybrid) | 542,834 | 128,626 | 23 | 76,342 | 0.0 | 12/0/0 |

## Pre-registered ratios

| Usage | Target | V2/V1 tokens | V1/grep tokens | V2/grep tokens | Hybrid/grep tokens | V2/V1 calls | Hybrid/grep calls |
|---|---|---:|---:|---:|---:|---:|---:|
| continuous | large | 0.789 | 3.114 | 2.455 | 0.947 | 0.419 | 0.947 |
| continuous | small | 0.296 | 4.503 | 1.335 | 0.830 | 0.085 | 0.950 |
| one-shot | large | 0.753 | 2.284 | 1.721 | 0.715 | 0.747 | 0.690 |
| one-shot | small | 0.498 | 4.715 | 2.347 | 1.074 | 0.704 | 1.000 |
