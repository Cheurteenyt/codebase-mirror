# R179 T01 stability repetition 2: complete selected per-task tables

Each arm cell is `raw native tokens / completed calls / response bytes / grade / validity`.
The committed CSV beside this file is the canonical machine-readable table and retains every registered attribution field.

## one-shot — small

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T01 | 48,809 / 1 / 2,767 / PASS / valid | 159,133 / 8 / 36,684 / PASS / valid |

## one-shot — large

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T01 | 66,929 / 1 / 6,747 / PASS / valid | 292,156 / 10 / 84,761 / PARTIAL / valid |

## continuous — small

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T01 | 50,430 / 1 / 2,767 / PASS / valid | 248,368 / 14 / 47,094 / PASS / valid |

## continuous — large

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T01 | 69,622 / 1 / 6,747 / PASS / valid | 406,968 / 15 / 61,791 / PARTIAL / valid |
