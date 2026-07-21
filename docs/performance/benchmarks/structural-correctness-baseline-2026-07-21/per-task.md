# Structural correctness baseline: complete selected per-task tables

Each arm cell is `raw native tokens / completed calls / response bytes / grade / validity`.
The committed CSV beside this file is the canonical machine-readable table and retains every registered attribution field.

## one-shot — small

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T01 | 100,040 / 7 / 5,534 / PARTIAL / valid | 136,577 / 7 / 35,874 / FAIL / valid |
| T02 | 693,408 / 21 / 98,570 / PASS / valid | 140,990 / 6 / 30,736 / PASS / valid |
| T03 | 47,670 / 1 / 516 / PASS / valid | 38,185 / 2 / 5,456 / PASS / valid |
| T04 | 75,988 / 3 / 21,486 / PASS / valid | 50,567 / 2 / 9,153 / PASS / valid |

## one-shot — large

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T01 | 615,435 / 30 / 104,935 / FAIL / valid | 356,776 / 23 / 62,163 / PASS / valid |
| T02 | 256,379 / 8 / 76,271 / PASS / valid | 232,503 / 8 / 95,836 / PASS / valid |
| T03 | 104,828 / 4 / 17,684 / PASS / valid | 51,643 / 3 / 3,181 / PASS / valid |
| T04 | 65,359 / 2 / 1,456 / PASS / valid | 49,643 / 3 / 1,335 / PASS / valid |

## continuous — small

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T01 | 106,822 / 7 / 5,534 / PARTIAL / valid | 393,125 / 11 / 696,164 / PARTIAL / valid |
| T02 | 479,872 / 15 / 81,660 / PARTIAL / valid | 690,218 / 5 / 36,488 / PASS / valid |
| T03 | 614,536 / 2 / 9,158 / PASS / valid | 856,771 / 2 / 4,972 / PASS / valid |
| T04 | 762,386 / 2 / 16,753 / PASS / valid | 1,030,044 / 2 / 4,058 / PASS / valid |

## continuous — large

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T01 | 356,748 / 16 / 92,379 / FAIL / valid | 352,601 / 12 / 81,159 / PARTIAL / valid |
| T02 | 768,975 / 7 / 44,249 / PASS / valid | 518,440 / 3 / 12,828 / PARTIAL / valid |
| T03 | 1,009,202 / 3 / 14,249 / PASS / valid | 652,369 / 2 / 2,835 / PASS / valid |
| T04 | 1,194,988 / 2 / 1,456 / PASS / valid | 743,296 / 1 / 361 / PASS / valid |
