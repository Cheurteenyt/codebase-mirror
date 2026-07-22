# R179 T01 stability repetition 3: complete selected per-task tables

Each arm cell is `raw native tokens / completed calls / response bytes / grade / validity`.
The committed CSV beside this file is the canonical machine-readable table and retains every registered attribution field.

## one-shot — small

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T01 | 49,383 / 1 / 2,767 / PASS / valid | 181,594 / 8 / 35,374 / PASS / valid |

## one-shot — large

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T01 | 66,595 / 1 / 6,747 / PASS / valid | 385,898 / 13 / 76,372 / PASS / valid |

## continuous — small

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T01 | 41,888 / 1 / 2,767 / PASS / valid | 348,779 / 16 / 32,968 / FAIL / valid |

## continuous — large

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T01 | 68,387 / 1 / 6,747 / PASS / valid | 314,177 / 11 / 66,569 / PARTIAL / valid |
