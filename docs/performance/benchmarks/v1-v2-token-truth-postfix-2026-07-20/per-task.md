# V1/V2 token-truth postfix: complete selected per-task tables

Each arm cell is `raw native tokens / completed calls / response bytes / grade / validity`.
The committed CSV beside this file is the canonical machine-readable table and retains every registered attribution field.

## one-shot — small

| Task | A: V1 MCP | B: V2 MCP | C: grep/read | D: hybrid |
|---|---:|---:|---:|---:|
| T01 | 236,696 / 22 / 65,881 / PASS / valid | 73,334 / 3 / 25,333 / PASS / valid | 62,883 / 3 / 3,686 / PASS / valid | 63,839 / 3 / 3,829 / PASS / valid |
| T02 | 53,914 / 2 / 1,258 / PASS / valid | 97,316 / 3 / 2,007 / PASS / valid | 30,267 / 1 / 94 / PASS / valid | 30,444 / 1 / 97 / PASS / valid |
| T03 | 53,571 / 2 / 1,078 / PASS / valid | 63,486 / 2 / 2,976 / PASS / valid | 45,261 / 2 / 1,517 / PASS / valid | 24,708 / 1 / 1,515 / PASS / valid |
| T04 | 104,441 / 10 / 29,643 / PASS / valid | 68,699 / 2 / 9,491 / PASS / valid | 36,807 / 2 / 630 / PASS / valid | 24,556 / 1 / 315 / PASS / valid |
| T05 | 116,523 / 13 / 10,263 / PASS / valid | 63,874 / 2 / 2,664 / PASS / valid | 24,689 / 1 / 1,063 / PASS / valid | 24,955 / 1 / 1,063 / PASS / valid |
| T06 | 455,487 / 35 / 369,670 / PASS / valid | 38,025 / 1 / 1,305 / PASS / valid | 24,325 / 1 / 312 / PASS / valid | 30,175 / 1 / 312 / PASS / valid |
| T07 | 138,494 / 7 / 12,414 / PASS / valid | 63,986 / 2 / 1,309 / PASS / valid | 47,801 / 2 / 5,198 / PASS / valid | 37,705 / 2 / 3,215 / PASS / valid |
| T08 | 434,342 / 17 / 90,411 / PASS / valid | 48,690 / 1 / 1,432 / PASS / valid | 92,718 / 4 / 17,757 / PASS / valid | 190,267 / 6 / 78,273 / PASS / valid |
| T09 | 161,183 / 9 / 18,499 / PASS / valid | 39,050 / 1 / 1,264 / PASS / valid | 67,628 / 5 / 16,191 / PASS / valid | 67,754 / 4 / 11,078 / PASS / valid |
| T10 | 288,189 / 17 / 49,603 / PARTIAL / valid | 48,878 / 1 / 3,731 / PASS / valid | 47,019 / 2 / 2,360 / PASS / valid | 49,024 / 2 / 10,812 / PASS / valid |
| T11 | 296,422 / 16 / 141,149 / PASS / valid | 109,071 / 12 / 21,201 / PASS / valid | 60,798 / 3 / 1,086 / PASS / valid | 49,736 / 3 / 1,086 / PASS / valid |
| T12 | 87,791 / 4 / 16,812 / PASS / valid | 48,232 / 1 / 305 / PASS / valid | 31,302 / 1 / 23,002 / PASS / valid | 37,575 / 1 / 23,002 / PASS / valid |

## one-shot — large

| Task | A: V1 MCP | B: V2 MCP | C: grep/read | D: hybrid |
|---|---:|---:|---:|---:|
| T01 | 81,692 / 10 / 13,215 / PASS / valid | 72,763 / 3 / 11,665 / PASS / valid | 24,626 / 1 / 1,087 / PASS / valid | 24,606 / 1 / 1,087 / PASS / valid |
| T02 | 63,502 / 2 / 1,396 / PASS / valid | 68,587 / 3 / 4,576 / PASS / valid | 30,226 / 1 / 105 / PASS / valid | 29,970 / 1 / 105 / PASS / valid |
| T03 | 54,054 / 2 / 1,565 / PASS / valid | 64,655 / 2 / 1,048 / PASS / valid | 24,195 / 1 / 92 / PASS / valid | 24,452 / 1 / 89 / PASS / valid |
| T04 | 54,828 / 7 / 12,021 / PASS / valid | 55,713 / 2 / 13,447 / PASS / valid | 30,414 / 1 / 463 / PASS / valid | 24,480 / 1 / 463 / PASS / valid |
| T05 | 86,474 / 15 / 13,942 / PASS / valid | 48,997 / 1 / 3,237 / PASS / valid | 24,810 / 1 / 1,914 / PASS / valid | 24,980 / 1 / 1,914 / PASS / valid |
| T06 | 254,535 / 25 / 271,886 / PASS / valid | 48,850 / 1 / 3,071 / PASS / valid | 24,346 / 1 / 277 / PASS / valid | 24,660 / 1 / 277 / PASS / valid |
| T07 | 99,789 / 5 / 5,881 / PASS / valid | 64,914 / 2 / 1,457 / PASS / valid | 47,581 / 2 / 7,661 / PASS / valid | 50,905 / 3 / 5,077 / PASS / valid |
| T08 | 108,730 / 13 / 19,139 / FAIL / valid | 146,768 / 9 / 20,782 / FAIL / valid | 106,367 / 5 / 46,467 / FAIL / valid | 85,533 / 5 / 17,775 / FAIL / valid |
| T09 | 137,523 / 12 / 16,360 / PASS / valid | 48,717 / 1 / 2,200 / PASS / valid | 52,256 / 2 / 20,709 / PASS / valid | 49,754 / 2 / 15,144 / PASS / valid |
| T10 | 530,481 / 26 / 83,454 / PARTIAL / valid | 48,159 / 1 / 2,388 / PASS / valid | 50,261 / 3 / 1,699 / PASS / valid | 24,572 / 1 / 181 / PARTIAL / valid |
| T11 | 287,793 / 35 / 189,519 / PASS / valid | 69,245 / 2 / 9,737 / PASS / valid | 24,340 / 1 / 383 / PASS / valid | 30,560 / 1 / 383 / PASS / valid |
| T12 | 80,880 / 5 / 3,830 / PARTIAL / valid | 39,069 / 1 / 356 / PASS / valid | 140,594 / 5 / 42,303 / PASS / valid | 70,655 / 2 / 176,012 / PASS / valid |

## continuous — small

| Task | A: V1 MCP | B: V2 MCP | C: grep/read | D: hybrid |
|---|---:|---:|---:|---:|
| T01 | 223,136 / 23 / 84,518 / PASS / valid | 91,455 / 3 / 25,333 / PASS / valid | 66,926 / 4 / 4,074 / PASS / valid | 39,517 / 2 / 2,309 / PASS / valid |
| T02 | 317,442 / 2 / 1,258 / PASS / valid | 165,244 / 2 / 1,089 / PASS / valid | 96,062 / 1 / 97 / PASS / valid | 66,961 / 1 / 97 / PASS / valid |
| T03 | 413,473 / 2 / 1,078 / PASS / valid | 215,659 / 1 / 2,346 / PASS / valid | 125,996 / 1 / 1,515 / PASS / valid | 124,517 / 3 / 1,519 / PASS / valid |
| T04 | 512,258 / 8 / 29,220 / PASS / valid | 267,778 / 1 / 2,520 / PASS / valid | 157,289 / 1 / 315 / PASS / valid | 154,633 / 1 / 315 / PASS / valid |
| T05 | 616,096 / 10 / 9,454 / PASS / valid | 322,253 / 1 / 2,313 / PASS / valid | 189,600 / 1 / 1,063 / PASS / valid | 185,744 / 1 / 1,063 / PASS / valid |
| T06 | 1,023,996 / 14 / 225,773 / PASS / valid | 378,179 / 1 / 1,305 / PASS / valid | 222,970 / 1 / 732 / PASS / valid | 218,235 / 1 / 312 / PASS / valid |
| T07 | 1,257,001 / 4 / 7,139 / PASS / valid | 463,808 / 2 / 1,310 / PASS / valid | 274,685 / 2 / 1,876 / PASS / valid | 268,482 / 2 / 1,605 / PASS / valid |
| T08 | 1,507,803 / 6 / 57,339 / PASS / valid | 522,068 / 1 / 1,110 / PASS / valid | 310,687 / 1 / 737 / PASS / valid | 303,499 / 1 / 737 / PASS / valid |
| T09 | 1,664,048 / 4 / 16,592 / PASS / valid | 581,386 / 1 / 1,264 / PASS / valid | 391,694 / 4 / 14,230 / PASS / valid | 358,732 / 2 / 3,458 / PASS / valid |
| T10 | 1,932,858 / 131 / 2,321,084 / PASS / valid | 642,486 / 1 / 3,731 / PASS / valid | 436,886 / 1 / 354 / PASS / valid | 417,204 / 2 / 472 / PASS / valid |
| T11 | 2,099,262 / 8 / 61,902 / PASS / valid | 705,867 / 1 / 1,552 / PASS / valid | 483,408 / 1 / 722 / PASS / valid | 457,682 / 1 / 722 / PASS / valid |
| T12 | 2,328,801 / 3 / 29,432 / PASS / valid | 770,117 / 1 / 305 / PASS / valid | 538,005 / 1 / 23,002 / PASS / valid | 505,793 / 1 / 21,678 / PASS / valid |

## continuous — large

| Task | A: V1 MCP | B: V2 MCP | C: grep/read | D: hybrid |
|---|---:|---:|---:|---:|
| T01 | 205,024 / 16 / 45,612 / PASS / valid | 119,931 / 16 / 33,782 / PASS / valid | 31,662 / 1 / 1,087 / PASS / valid | 31,834 / 1 / 1,087 / PASS / valid |
| T02 | 287,079 / 2 / 1,091 / PASS / valid | 167,495 / 1 / 434 / PASS / valid | 63,990 / 1 / 105 / PASS / valid | 64,374 / 1 / 105 / PASS / valid |
| T03 | 370,921 / 2 / 1,565 / PASS / valid | 215,581 / 1 / 415 / PASS / valid | 96,743 / 1 / 92 / PASS / valid | 97,339 / 1 / 92 / PASS / valid |
| T04 | 459,925 / 7 / 11,433 / PASS / valid | 290,052 / 2 / 3,839 / PASS / valid | 130,029 / 1 / 463 / PASS / valid | 130,843 / 1 / 463 / PASS / valid |
| T05 | 592,741 / 15 / 13,942 / PASS / valid | 341,888 / 1 / 3,237 / PASS / valid | 164,432 / 1 / 1,863 / PASS / valid | 165,478 / 1 / 1,863 / PASS / valid |
| T06 | 853,725 / 14 / 83,866 / PASS / valid | 395,675 / 1 / 3,071 / PASS / valid | 199,964 / 1 / 271 / PASS / valid | 201,257 / 1 / 271 / PASS / valid |
| T07 | 1,126,049 / 4 / 5,378 / PASS / valid | 478,838 / 2 / 1,458 / PASS / valid | 274,180 / 3 / 4,871 / PASS / valid | 295,219 / 4 / 2,113 / PASS / valid |
| T08 | 1,304,108 / 3 / 20,666 / FAIL / valid | 596,461 / 5 / 7,012 / FAIL / valid | 314,850 / 1 / 4,478 / FAIL / valid | 336,078 / 1 / 5,654 / FAIL / valid |
| T09 | 1,493,866 / 7 / 12,984 / PASS / valid | 658,995 / 1 / 2,200 / PASS / valid | 382,341 / 2 / 10,812 / PASS / valid | 431,074 / 3 / 12,026 / PASS / valid |
| T10 | 1,693,323 / 3 / 3,766 / PARTIAL / valid | 723,183 / 1 / 2,388 / PASS / valid | 431,397 / 1 / 234 / PASS / valid | 481,265 / 1 / 234 / PASS / valid |
| T11 | 2,111,816 / 9 / 33,503 / PASS / valid | 788,567 / 1 / 852 / PASS / valid | 481,215 / 1 / 383 / PASS / valid | 532,173 / 1 / 383 / PASS / valid |
| T12 | 2,425,724 / 4 / 1,411,902 / PARTIAL / valid | 855,133 / 1 / 356 / PASS / valid | 582,758 / 2 / 175,884 / PASS / valid | 584,039 / 1 / 121 / PASS / valid |
