# R179 T01 repetition and stability result

## Verdict

The R178 single-sample T01 result is **not stable under the pre-registered R179
protocol**. Only 3 of 8 cell/arm groups satisfy the `max / min <= 1.20` native
raw-token rule, two grep/read groups change grade, the R178 grep/read grade
pattern is not reproduced, and the three matched aggregate C/B ratios have a
`1.270665` max/min spread. The 20% ceiling was `1.20`.

The directional finding is nevertheless consistent in this limited round:
V2 B is 12/12 PASS, grep/read C uses more raw tokens in every matched
repetition, and the historical `5.166401365x` point lies inside the observed
`4.279942665x` to `5.438372088x` C/B range. That means the old point is
plausible within the new range, not that it is a repeatable point estimate.
R179 is descriptive N=3 evidence and makes no population-level confidence
claim.

## Every repetition by cell and arm

Each repetition entry is `native raw tokens / completed calls / grade`.
Means are arithmetic native-token means. `Token stable` applies the immutable
20% max/min ceiling; `Grade stable` requires three identical grades.

| Usage / target | Arm | Repetition 1 | Repetition 2 | Repetition 3 | Min | Max | Mean | Max/min | Token stable | Grade stable |
|---|---|---:|---:|---:|---:|---:|---:|---:|:---:|:---:|
| one-shot / small | B V2 MCP | 48,964 / 1 / PASS | 48,809 / 1 / PASS | 49,383 / 1 / PASS | 48,809 | 49,383 | 49,052.00 | 1.011760 | yes | yes |
| one-shot / small | C grep/read | 219,560 / 10 / PASS | 159,133 / 8 / PASS | 181,594 / 8 / PASS | 159,133 | 219,560 | 186,762.33 | 1.379726 | **no** | yes |
| one-shot / large | B V2 MCP | 66,864 / 1 / PASS | 66,929 / 1 / PASS | 66,595 / 1 / PASS | 66,595 | 66,929 | 66,796.00 | 1.005015 | yes | yes |
| one-shot / large | C grep/read | 319,234 / 12 / PARTIAL | 292,156 / 10 / PARTIAL | 385,898 / 13 / PASS | 292,156 | 385,898 | 332,429.33 | 1.320863 | **no** | **no** |
| continuous / small | B V2 MCP | 50,360 / 1 / PASS | 50,430 / 1 / PASS | 41,888 / 1 / PASS | 41,888 | 50,430 | 47,559.33 | 1.203925 | **no** | yes |
| continuous / small | C grep/read | 198,934 / 8 / FAIL | 248,368 / 14 / PASS | 348,779 / 16 / FAIL | 198,934 | 348,779 | 265,360.33 | 1.753240 | **no** | **no** |
| continuous / large | B V2 MCP | 69,621 / 1 / PASS | 69,622 / 1 / PASS | 68,387 / 1 / PASS | 68,387 | 69,622 | 69,210.00 | 1.018059 | yes | yes |
| continuous / large | C grep/read | 271,521 / 19 / PARTIAL | 406,968 / 15 / PARTIAL | 314,177 / 11 / PARTIAL | 271,521 | 406,968 | 330,888.67 | 1.498845 | **no** | yes |

All four C groups fail token stability. Three B groups pass; continuous/small B
misses the ceiling narrowly at `1.203925`. Grade invariance holds for every B
group, one-shot/small C, and continuous/large C. It fails for one-shot/large C
and continuous/small C.

The registered R178 C pattern was FAIL on small and PARTIAL on large in both
usage modes. R179 does not preserve it: one-shot/small is PASS in all three
repetitions, continuous/small is FAIL/PASS/FAIL, one-shot/large is
PARTIAL/PARTIAL/PASS, and only continuous/large remains PARTIAL throughout.

## Matched aggregate repetitions and round cost

| Repetition | B raw tokens | C raw tokens | C/B | B grades P/Pt/F | C grades P/Pt/F | B calls | C calls | Total round tokens |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 235,809 | 1,009,249 | 4.279942665x | 4/0/0 | 1/2/1 | 4 | 49 | 1,245,058 |
| 2 | 235,790 | 1,106,625 | 4.693265194x | 4/0/0 | 2/2/0 | 4 | 47 | 1,342,415 |
| 3 | 226,253 | 1,230,448 | 5.438372088x | 4/0/0 | 2/1/1 | 4 | 48 | 1,456,701 |
| **Total** | **697,852** | **3,346,322** | **4.795174335x combined** | **12/0/0** | **5/5/2** | **12** | **144** | **4,044,174** |

The matched-ratio min is `4.279942665x`, the max is `5.438372088x`, their
max/min spread is `1.270664706`, and their arithmetic mean is `4.803859982x`.
The spread therefore fails the pre-registered `<= 1.20` rule. In the combined
descriptive total, B uses 79.1457009% fewer raw tokens than C. The actual round
cost of 4,044,174 native raw tokens is 337,122 tokens (7.6946%) below the
pre-registered 4,381,296 projection; all measured B and C tokens are included.

## Environment before every runner invocation

The environment was captured immediately before each of the 12 runner
invocations. RAM is physical bytes. The SHA is the already-pushed immutable
pre-registration commit.

| Invocation | UTC environment capture | OS | CPU / logical processors | RAM | Node / npm | Codex / model / reasoning | Pre-registration SHA |
|---|---|---|---|---:|---|---|---|
| one-shot small r1 | 2026-07-22T19:01:12.1073371Z | Windows 11 Professionnel 10.0.26200 build 26200, 64-bit | AMD Ryzen 9 5900X 12-Core / 24 | 42,849,894,400 | 24.15.0 / 11.12.1 | 0.144.4 / gpt-5.6-sol / medium | `c2fbaeeb7228bd7f832e25ffa0f3115bdf2b6b57` |
| one-shot small r2 | 2026-07-22T19:02:49.0410340Z | Windows 11 Professionnel 10.0.26200 build 26200, 64-bit | AMD Ryzen 9 5900X 12-Core / 24 | 42,849,894,400 | 24.15.0 / 11.12.1 | 0.144.4 / gpt-5.6-sol / medium | `c2fbaeeb7228bd7f832e25ffa0f3115bdf2b6b57` |
| one-shot small r3 | 2026-07-22T19:04:17.5329426Z | Windows 11 Professionnel 10.0.26200 build 26200, 64-bit | AMD Ryzen 9 5900X 12-Core / 24 | 42,849,894,400 | 24.15.0 / 11.12.1 | 0.144.4 / gpt-5.6-sol / medium | `c2fbaeeb7228bd7f832e25ffa0f3115bdf2b6b57` |
| one-shot large r1 | 2026-07-22T19:05:58.2546728Z | Windows 11 Professionnel 10.0.26200 build 26200, 64-bit | AMD Ryzen 9 5900X 12-Core / 24 | 42,849,894,400 | 24.15.0 / 11.12.1 | 0.144.4 / gpt-5.6-sol / medium | `c2fbaeeb7228bd7f832e25ffa0f3115bdf2b6b57` |
| one-shot large r2 | 2026-07-22T19:08:46.0261599Z | Windows 11 Professionnel 10.0.26200 build 26200, 64-bit | AMD Ryzen 9 5900X 12-Core / 24 | 42,849,894,400 | 24.15.0 / 11.12.1 | 0.144.4 / gpt-5.6-sol / medium | `c2fbaeeb7228bd7f832e25ffa0f3115bdf2b6b57` |
| one-shot large r3 | 2026-07-22T19:11:44.8938734Z | Windows 11 Professionnel 10.0.26200 build 26200, 64-bit | AMD Ryzen 9 5900X 12-Core / 24 | 42,849,894,400 | 24.15.0 / 11.12.1 | 0.144.4 / gpt-5.6-sol / medium | `c2fbaeeb7228bd7f832e25ffa0f3115bdf2b6b57` |
| continuous small r1 | 2026-07-22T19:14:46.2636563Z | Windows 11 Professionnel 10.0.26200 build 26200, 64-bit | AMD Ryzen 9 5900X 12-Core / 24 | 42,849,894,400 | 24.15.0 / 11.12.1 | 0.144.4 / gpt-5.6-sol / medium | `c2fbaeeb7228bd7f832e25ffa0f3115bdf2b6b57` |
| continuous small r2 | 2026-07-22T19:16:16.1007551Z | Windows 11 Professionnel 10.0.26200 build 26200, 64-bit | AMD Ryzen 9 5900X 12-Core / 24 | 42,849,894,400 | 24.15.0 / 11.12.1 | 0.144.4 / gpt-5.6-sol / medium | `c2fbaeeb7228bd7f832e25ffa0f3115bdf2b6b57` |
| continuous small r3 | 2026-07-22T19:18:17.8674978Z | Windows 11 Professionnel 10.0.26200 build 26200, 64-bit | AMD Ryzen 9 5900X 12-Core / 24 | 42,849,894,400 | 24.15.0 / 11.12.1 | 0.144.4 / gpt-5.6-sol / medium | `c2fbaeeb7228bd7f832e25ffa0f3115bdf2b6b57` |
| continuous large r1 | 2026-07-22T19:20:15.8949882Z | Windows 11 Professionnel 10.0.26200 build 26200, 64-bit | AMD Ryzen 9 5900X 12-Core / 24 | 42,849,894,400 | 24.15.0 / 11.12.1 | 0.144.4 / gpt-5.6-sol / medium | `c2fbaeeb7228bd7f832e25ffa0f3115bdf2b6b57` |
| continuous large r2 | 2026-07-22T19:22:58.3408608Z | Windows 11 Professionnel 10.0.26200 build 26200, 64-bit | AMD Ryzen 9 5900X 12-Core / 24 | 42,849,894,400 | 24.15.0 / 11.12.1 | 0.144.4 / gpt-5.6-sol / medium | `c2fbaeeb7228bd7f832e25ffa0f3115bdf2b6b57` |
| continuous large r3 | 2026-07-22T19:26:13.3629886Z | Windows 11 Professionnel 10.0.26200 build 26200, 64-bit | AMD Ryzen 9 5900X 12-Core / 24 | 42,849,894,400 | 24.15.0 / 11.12.1 | 0.144.4 / gpt-5.6-sol / medium | `c2fbaeeb7228bd7f832e25ffa0f3115bdf2b6b57` |

There was no environment or version drift. The earliest measured cell started
at `2026-07-22T19:01:13.546Z`, after the pre-registration commit was recorded
remotely at `2026-07-22T18:58:30Z`. All 24 cells use attempt 1, exit 0, the two
registered target SHAs, `project_doc_max_bytes=0`, approval `never`, and zero
prior observed context bytes for all 12 continuous cells.

## Immutable repetition identities

Each linked checkpoint contains its eight selected-run CSV rows, per-task
table, aggregate table, and raw-artifact manifest. Derived files are excluded
from the raw manifest.

| Repetition | External append-once root | Valid selected cells | Raw artifacts | Raw bytes | Tree SHA-256 |
|---:|---|---:|---:|---:|---|
| [1](rep-1/aggregate-and-ratios.md) ([per-task](rep-1/per-task.md)) | `D:/Mycodex/benchmark-results/r179-t01-stability-rep-1` | 8/8 | 40 | 317,814 | `7e89906b6063c501d1ce5b4aca8069832c51886911d57a2b0637578ed42d0d47` |
| [2](rep-2/aggregate-and-ratios.md) ([per-task](rep-2/per-task.md)) | `D:/Mycodex/benchmark-results/r179-t01-stability-rep-2` | 8/8 | 40 | 358,692 | `67f3d6a4629ea662da57134b50f955d930176f80d83774a8bf296e31ffc116d6` |
| [3](rep-3/aggregate-and-ratios.md) ([per-task](rep-3/per-task.md)) | `D:/Mycodex/benchmark-results/r179-t01-stability-rep-3` | 8/8 | 40 | 338,619 | `34321cb9094f2610b195d36789606f5e87b211acdf51276bc12efbd6f5c896fe` |

No attempt 2 or invalid-run replacement exists. The three manifests cover 120
raw artifacts and 1,015,125 bytes in total, with separate identities so no
duplicate cell key is collapsed across repetitions.

## Verification

- `npm run docs:check` passed with all benchmark questions, links, anchors,
  metadata, and portal reachability verified.
- Pre-registration CI run `29949018208` and measured-checkpoint CI run
  `29951530497` passed backend, frontend, Windows, package, and Docker jobs.
- The final data audit re-hashed all 120 raw artifacts, reproduced all three
  manifest tree hashes, proved all three committed CSV files byte-identical to
  the derived runner CSV files, and independently recalculated all 24 selected
  cells and three matched aggregates.
- The diff from anchor `148e4b65849efc3fcfbc4fb716abf0898424293d`
  contains documentation evidence only. No product, runner, task, oracle,
  policy, grading, package, or Graph UI file changed.
