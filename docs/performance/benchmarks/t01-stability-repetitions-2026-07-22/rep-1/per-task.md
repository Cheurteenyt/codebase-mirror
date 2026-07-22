# R179 T01 stability repetition 1: complete selected per-task tables

Each arm cell is `raw native tokens / completed calls / response bytes / grade / validity`.
The committed CSV beside this file is the canonical machine-readable table and retains every registered attribution field.

## one-shot — small

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T01 | 48,964 / 1 / 2,767 / PASS / valid | 219,560 / 10 / 39,349 / PASS / valid |

## one-shot — large

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T01 | 66,864 / 1 / 6,747 / PASS / valid | 319,234 / 12 / 50,888 / PARTIAL / valid |

## continuous — small

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T01 | 50,360 / 1 / 2,767 / PASS / valid | 198,934 / 8 / 41,880 / FAIL / valid |

## continuous — large

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T01 | 69,621 / 1 / 6,747 / PASS / valid | 271,521 / 19 / 63,809 / PARTIAL / valid |
