# R178 fresh V2 MCP versus grep/read multi-hop: complete selected per-task tables

Each arm cell is `raw native tokens / completed calls / response bytes / grade / validity`.
The committed CSV beside this file is the canonical machine-readable table and retains every registered attribution field.

## one-shot — small

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T01 | 49,200 / 1 / 2,767 / PASS / valid | 196,753 / 8 / 46,755 / FAIL / valid |

## one-shot — large

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T01 | 67,075 / 1 / 6,747 / PASS / valid | 391,993 / 13 / 88,373 / PARTIAL / valid |

## continuous — small

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T01 | 50,871 / 1 / 2,767 / PASS / valid | 361,041 / 21 / 45,200 / FAIL / valid |

## continuous — large

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T01 | 69,691 / 1 / 6,747 / PASS / valid | 273,808 / 10 / 62,774 / PARTIAL / valid |
