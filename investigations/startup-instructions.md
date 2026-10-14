# ARM startup instruction investigation

Compacting only renderer-worker whitespace reduces measured cumulative startup work by **1.4%** in nine alternating pairs. The original first-visible-window metric remains **inconclusive**: its median increased 2.8% in this run, with large overlapping ranges and gains in only four pairs. This does not establish an improvement to the screenshot's 3,250M-instruction result.

The measured cumulative reduction is actual avoided work, consistent with the smaller parsing input, without changing initialization order or introducing delayed tasks. [LVCE PR 15954](https://github.com/lvce-editor/lvce-editor/pull/15954) is merged at `8ac2961d3c0c786dcf062ae4f122ab89414fd89f` after platform and packaged-functionality validation. The cumulative guard is not a measurement of usable-editor readiness.

## Fixed inputs and accounting

The screenshot corresponds to benchmark commit `657c144ab1d4985ba31fa80232da59d2005b5ba5` and [successful run 38481968035](https://github.com/levivilet/startup-instructions-benchmark/actions/runs/38481968035). Its LVCE counts are 3,289,184,167 / 3,221,057,595 / 3,250,346,466. The pinned `v0.122.9` ARM Debian package has SHA-256 `5d7cb83a4bd34034f20a45dcd113f3bdd283a69859d7564e16dbfc4cb7d11478` and contains Electron 44.7.0.

Each launch has a fresh HOME/XDG/Chromium profile, software graphics and the same artifact/runtime. OS caches may be warm. The production per-CPU cgroup instruction counter includes descendants and exited tasks, with controller/desktop work outside the cgroup and acknowledged disable before shutdown. The unchanged detached-child/cutoff/controller accounting gate passed. All reported trial counters are valid with 100% running time.

Native sampling uses separate launches and cgroup-scoped `cycles:u` at 997 Hz with DWARF stacks. There are no lost samples. Matching official Electron 44.7.0 ARM symbols identify substantial V8 scanner, preparser, bytecode-generation and compiler activity. The symbols archive checksum is `2f1950f9928754f9a59e4016fa589cadf43d5e7c5d02e6b19f154875844c879a`; its module identity matches executable build ID `1ee3bc5ef5a5640d7c609ef6a9a614ef1542ec35`. Some symbols and PAC-looking unwind addresses remain unresolved; these samples do not precisely attribute all work to one application module.

The empty Electron comparison uses 44.3.0, so its difference from LVCE is not isolated application overhead. It is not used to calculate the candidate improvement.

## Candidate and results

Only the packaged `rendererWorkerMain.js` changes. Esbuild 0.28.2 uses `minifyWhitespace=true`, `minifyIdentifiers=false`, `minifySyntax=false` and inline legal comments. Its source falls from 2,272,172 to 1,623,559 bytes (28.5%). Independently parsed complete ASTs are equal after excluding source positions, literal spelling and annotation metadata, retaining every identifier, value and operation. Main/shared process sources, runtime, dependencies and startup scheduling stay fixed.

The [nine-pair experiment](https://github.com/lvce-editor/performance-investigations/actions/runs/38551289606) alternates baseline then candidate. A separate set of launches extends the counter cutoff to five seconds after observing the same normal window. That extended boundary is explicitly a cumulative-work guard; its counts are never published as first-window benchmark results.

| Boundary | Baseline median | Candidate median | Candidate change | Lower candidate pairs |
| --- | ---: | ---: | ---: | ---: |
| First visible normal window | 3,493,398,277 | 3,590,858,692 | +2.79% | 4/9 |
| Window plus five seconds | 7,117,844,499 | 7,018,125,444 | -1.40% | 9/9 |

At the cumulative boundary every candidate count (6,982,124,514–7,035,061,732) is lower than every baseline count (7,082,801,422–7,138,965,841). Pairwise reductions range from 0.90% to 2.02%. An earlier independent three-pair run also found separated cumulative ranges and a 1.82% median reduction. First-window pair differences range from -12.52% to +11.15%; the small potential improvement cannot be separated from cutoff/startup scheduling variation.

[Raw results](startup-instructions-results.json) retain all 36 instruction counts, raw counter output, commands, host information, window properties and exact transform hashes. The workflow artifact also contains sampled data, readable stacks and original/candidate JavaScript. Neither the public benchmark's complete editor matrix nor its Pages publication gates are changed by this targeted LVCE investigation.

## Scope of production validation

The proposed build change enables whitespace compaction only for the renderer-worker bundle. A focused execution regression checks both normal and compact bundles, asynchronous IPC configuration before dynamic module initialization, worker URL values and function-name preservation. Current renderer source also produces equivalent complete ASTs with and without whitespace compaction (2,274,761 versus 1,658,681 bytes in the inspected source graph).

[Production CI run 38552381675](https://github.com/lvce-editor/lvce-editor/actions/runs/38552381675) passed all four intended jobs: Linux, macOS, Windows x64 and Windows ARM64. Linux also passed regular/ASAR packaged startup profiling, file/diagnostic provider acceptance, both native font-loading paths and tab-move regressions. No memory or validation gate was adjusted.

The Linux Debian artifact from that exact PR head was extracted and launched under isolated XDG/Chromium directories, a private D-Bus session and Xvfb/Openbox. Real GUI acceptance passed opening the TypeScript and plaintext fixtures, editing and saving text, installed-extension listing, changing the theme to gruvbox, changing auto-save to onFocusChange, and normal exit/relaunch. Both editor tabs, saved text, theme and preference were restored. The expected TypeScript TS2322 diagnostic appeared before and after relaunch, demonstrating language-extension activation. Task-owned app/display/D-Bus processes were closed; no real profile was changed. Screenshots and execution evidence are preserved in the assigned task's local attempt directory.

The final investigation-head [ARM run 38552557968](https://github.com/lvce-editor/performance-investigations/actions/runs/38552557968) independently reproduced a 1.38% cumulative median reduction with all nine candidate pairs lower and non-overlapping variant ranges. Its first-window medians again overlapped despite a 1.39% difference, reinforcing that a stable first-window gain has not been established.

The change is integrated into application main; no dependency publication is required for this build-only option. It will be included in subsequent application builds/releases. The evidence supports a modest reduction in actual cumulative startup work, with the original first-window result explicitly inconclusive.
