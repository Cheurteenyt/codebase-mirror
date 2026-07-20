# V1/V2 token-truth baseline: complete selected per-task tables

Each arm cell is `raw native tokens / completed calls / response bytes / grade / validity`.
The committed CSV beside this file is the canonical machine-readable table and retains every registered attribution field.

## one-shot — small

| Task | A: V1 MCP | B: V2 MCP | C: grep/read | D: hybrid |
|---|---:|---:|---:|---:|
| T01 | 97,426 / 5 / 210 / FAIL / INVALID a2 | 88,399 / 3 / 25,333 / PASS / valid | 79,271 / 4 / 4,095 / PASS / valid | 46,321 / 2 / 2,309 / PASS / valid |
| T02 | 53,825 / 2 / 1,258 / PASS / valid | 37,132 / 1 / 437 / PASS / valid | 30,237 / 1 / 94 / PASS / valid | 30,054 / 1 / 97 / PASS / valid |
| T03 | 63,957 / 2 / 1,078 / PASS / valid | 64,250 / 2 / 1,326 / PASS / valid | 30,158 / 1 / 1,515 / PASS / valid | 30,774 / 1 / 1,515 / PASS / valid |
| T04 | 59,929 / 8 / 29,457 / PASS / valid | 55,067 / 2 / 9,491 / PASS / valid | 30,013 / 1 / 315 / PASS / valid | 30,111 / 1 / 315 / PASS / valid |
| T05 | 99,382 / 16 / 10,012 / PASS / valid | 48,291 / 1 / 2,313 / PASS / valid | 30,779 / 1 / 1,063 / PASS / valid | 30,919 / 1 / 1,063 / PASS / valid |
| T06 | 525,488 / 28 / 352,194 / PASS / valid | 47,894 / 1 / 1,305 / PASS / valid | 30,043 / 1 / 312 / PASS / valid | 24,559 / 1 / 312 / PASS / valid |
| T07 | 137,532 / 6 / 7,581 / PASS / valid | 100,537 / 5 / 10,616 / PASS / valid | 47,748 / 2 / 5,364 / PASS / valid | 47,066 / 2 / 4,776 / PASS / valid |
| T08 | 417,709 / 23 / 125,177 / PASS / valid | 248,674 / 14 / 60,153 / PASS / valid | 42,712 / 2 / 14,510 / PASS / valid | 115,756 / 6 / 28,198 / PASS / valid |
| T09 | 179,112 / 10 / 18,572 / PASS / valid | 85,105 / 4 / 13,312 / PASS / valid | 56,150 / 5 / 14,283 / PASS / valid | 63,864 / 3 / 4,725 / PASS / valid |
| T10 | 418,045 / 24 / 461,156 / PARTIAL / valid | 48,094 / 1 / 3,731 / PASS / valid | 30,720 / 1 / 2,006 / PASS / valid | 48,546 / 2 / 9,224 / PASS / valid |
| T11 | 218,366 / 14 / 81,257 / PASS / valid | 102,328 / 11 / 17,560 / PASS / valid | 60,733 / 3 / 1,086 / PASS / valid | 37,622 / 2 / 2,130 / PASS / valid |
| T12 | 112,901 / 4 / 1,752 / PASS / valid | 260,928 / 55 / 2,363,780 / PASS / valid | 37,019 / 1 / 23,002 / PASS / valid | 37,242 / 1 / 21,678 / PASS / valid |

## one-shot — large

| Task | A: V1 MCP | B: V2 MCP | C: grep/read | D: hybrid |
|---|---:|---:|---:|---:|
| T01 | 86,408 / 12 / 13,401 / PASS / valid | 85,800 / 9 / 14,881 / PASS / valid | 45,996 / 2 / 1,324 / PASS / valid | 30,696 / 1 / 1,087 / PASS / valid |
| T02 | 52,831 / 2 / 1,396 / PASS / valid | 64,490 / 2 / 2,390 / PASS / valid | 30,336 / 1 / 105 / PASS / valid | 30,402 / 1 / 105 / PASS / valid |
| T03 | 53,899 / 2 / 1,565 / PASS / valid | 63,348 / 2 / 1,048 / PASS / valid | 30,235 / 1 / 92 / PASS / valid | 30,430 / 1 / 89 / PASS / valid |
| T04 | 54,805 / 7 / 11,433 / PASS / valid | 66,847 / 3 / 15,322 / PASS / valid | 30,310 / 1 / 463 / PASS / valid | 30,550 / 1 / 463 / PASS / valid |
| T05 | 88,563 / 15 / 13,942 / PASS / valid | 48,461 / 1 / 3,237 / PASS / valid | 30,792 / 1 / 1,914 / PASS / valid | 31,008 / 1 / 1,914 / PASS / valid |
| T06 | 268,326 / 19 / 85,384 / PASS / valid | 48,275 / 1 / 3,071 / PASS / valid | 30,112 / 1 / 277 / PASS / valid | 24,510 / 1 / 277 / PASS / valid |
| T07 | 126,853 / 7 / 5,207 / PASS / valid | 64,569 / 2 / 3,000 / PASS / valid | 48,198 / 2 / 7,661 / PASS / valid | 47,841 / 2 / 7,661 / PASS / valid |
| T08 | 337,611 / 33 / 98,052 / FAIL / valid | 199,039 / 17 / 42,660 / FAIL / valid | 149,330 / 5 / 73,886 / FAIL / valid | 167,722 / 6 / 83,986 / FAIL / valid |
| T09 | 140,677 / 11 / 16,145 / PASS / valid | 452,519 / 26 / 224,693 / PASS / valid | 141,327 / 7 / 16,824 / PASS / valid | 49,836 / 2 / 15,464 / PASS / valid |
| T10 | 165,982 / 10 / 6,276 / PARTIAL / valid | 48,314 / 1 / 2,388 / PASS / valid | 46,965 / 2 / 5,032 / PARTIAL / valid | 30,315 / 1 / 234 / PASS / valid |
| T11 | 331,748 / 24 / 146,448 / PASS / valid | 66,653 / 2 / 9,737 / PASS / valid | 24,261 / 1 / 383 / PASS / valid | 24,462 / 1 / 383 / PASS / valid |
| T12 | 102,171 / 4 / 3,175 / PARTIAL / valid | 155,200 / 43 / 708,963 / PARTIAL / valid | 184,591 / 5 / 210,986 / PASS / valid | 69,155 / 2 / 168,616 / PARTIAL / valid |

## continuous — small

| Task | A: V1 MCP | B: V2 MCP | C: grep/read | D: hybrid |
|---|---:|---:|---:|---:|
| T01 | 154,245 / 20 / 65,602 / PASS / valid | 61,709 / 2 / 25,441 / PASS / valid | 82,539 / 4 / 4,348 / PASS / valid | 53,328 / 3 / 3,611 / PASS / valid |
| T02 | 246,979 / 2 / 1,258 / PASS / valid | 126,398 / 2 / 1,089 / PASS / valid | 117,629 / 1 / 97 / PASS / valid | 82,116 / 1 / 97 / PASS / valid |
| T03 | 341,441 / 2 / 1,078 / PASS / valid | 192,681 / 2 / 1,326 / PASS / valid | 153,188 / 1 / 170 / PASS / valid | 111,712 / 1 / 1,515 / PASS / valid |
| T04 | 439,624 / 8 / 29,220 / PASS / valid | 238,308 / 1 / 2,520 / PASS / valid | 189,781 / 1 / 315 / PASS / valid | 142,252 / 1 / 315 / PASS / valid |
| T05 | 545,642 / 10 / 9,454 / PASS / valid | 286,252 / 1 / 2,313 / PASS / valid | 227,421 / 1 / 1,063 / PASS / valid | 173,823 / 1 / 1,063 / PASS / valid |
| T06 | 926,641 / 15 / 232,944 / PASS / valid | 335,648 / 1 / 1,305 / PASS / valid | 266,536 / 1 / 312 / PASS / valid | 206,390 / 1 / 312 / PASS / valid |
| T07 | 1,174,304 / 4 / 7,139 / PASS / valid | 411,392 / 2 / 940 / PASS / valid | 326,741 / 2 / 1,605 / PASS / valid | 292,324 / 4 / 2,033 / PASS / valid |
| T08 | 1,487,806 / 10 / 85,459 / PASS / valid | 555,273 / 4 / 14,605 / PASS / valid | 390,655 / 2 / 3,954 / PASS / valid | 329,172 / 1 / 1,724 / PASS / valid |
| T09 | 1,657,564 / 4 / 16,592 / PASS / valid | 653,161 / 3 / 11,446 / PASS / valid | 485,476 / 3 / 10,047 / PASS / valid | 388,979 / 2 / 4,074 / PASS / valid |
| T10 | 4,704,005 / 216 / 3,777,081 / PASS / INVALID a2 | 722,133 / 1 / 3,731 / PASS / valid | 536,638 / 1 / 207 / PASS / valid | 495,779 / 2 / 532 / PASS / INVALID a2 |
| T11 | 3,187,371 / 1 / 2,349 / PASS / valid | 792,940 / 1 / 1,552 / PASS / valid | 588,700 / 1 / 722 / PASS / valid | 494,990 / 1 / 722 / PASS / valid |
| T12 | 3,392,880 / 2 / 15,479 / PASS / valid | 1,035,957 / 5 / 47,608 / PASS / valid | 689,251 / 2 / 44,104 / PASS / valid | 596,416 / 1 / 21,678 / PASS / valid |

## continuous — large

| Task | A: V1 MCP | B: V2 MCP | C: grep/read | D: hybrid |
|---|---:|---:|---:|---:|
| T01 | 108,099 / 11 / 13,308 / PASS / valid | 130,644 / 5 / 22,919 / PASS / valid | 31,204 / 1 / 1,087 / PASS / valid | 31,830 / 1 / 1,087 / PASS / valid |
| T02 | 173,368 / 2 / 1,091 / PASS / valid | 201,741 / 2 / 2,390 / PASS / valid | 63,514 / 1 / 105 / PASS / valid | 64,340 / 1 / 105 / PASS / valid |
| T03 | 241,064 / 2 / 1,565 / PASS / valid | 250,060 / 1 / 415 / PASS / valid | 96,273 / 1 / 92 / PASS / valid | 97,299 / 1 / 92 / PASS / valid |
| T04 | 313,923 / 7 / 11,433 / PASS / valid | 325,557 / 2 / 3,839 / PASS / valid | 129,565 / 1 / 463 / PASS / valid | 130,797 / 1 / 463 / PASS / valid |
| T05 | 397,920 / 10 / 13,477 / PASS / valid | 378,132 / 1 / 3,237 / PASS / valid | 164,000 / 1 / 1,863 / PASS / valid | 165,067 / 1 / 439 / PASS / valid |
| T06 | 627,401 / 12 / 22,779 / PASS / valid | 432,691 / 1 / 3,071 / PASS / valid | 199,562 / 1 / 271 / PASS / valid | 200,099 / 1 / 271 / PASS / valid |
| T07 | 821,793 / 4 / 5,378 / PASS / valid | 546,270 / 3 / 3,726 / PASS / valid | 292,892 / 4 / 4,228 / PASS / valid | 273,575 / 3 / 5,132 / PASS / valid |
| T08 | 994,747 / 4 / 14,778 / FAIL / valid | 667,906 / 3 / 7,194 / FAIL / valid | 375,048 / 3 / 5,194 / FAIL / valid | 335,177 / 2 / 5,925 / FAIL / valid |
| T09 | 1,133,253 / 7 / 12,984 / PASS / valid | 1,164,589 / 19 / 182,311 / PASS / valid | 442,669 / 2 / 10,649 / PASS / valid | 432,067 / 3 / 11,618 / PASS / valid |
| T10 | 1,622,500 / 16 / 51,879 / PARTIAL / valid | 1,291,363 / 1 / 2,388 / PASS / valid | 491,820 / 1 / 234 / PASS / valid | 454,111 / 1 / 222 / PASS / valid |
| T11 | 2,049,071 / 40 / 187,516 / PASS / valid | 1,419,754 / 1 / 852 / PASS / valid | 541,718 / 1 / 383 / PASS / valid | 504,225 / 1 / 383 / PASS / valid |
| T12 | 2,285,888 / 2 / 1,688 / PARTIAL / valid | 1,683,578 / 10 / 14,397 / FAIL / valid | 630,222 / 2 / 42,079 / PARTIAL / valid | 585,706 / 2 / 9,396 / PARTIAL / valid |
