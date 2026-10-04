# LVCE startup investigation

The merged ESLint optimization reduces **unprofiled cold readiness by 6.1%** in a three-run alternating CI comparison (25.14 s → 23.60 s). Graph construction improves by 14.4% in a separate comparison. The existing TypeScript RPC cache cuts actual filesystem requests by **78.3%** and sampled worker residency by **68.1%** in Electron; its full Linux/macOS/Windows CI passed and PR 703 is merged. These readiness measurements concern startup through diagnostics, not first paint.

The supplied capture is approximately 68 seconds long and waits for diagnostics. Its trace is Chromium JSON, despite being named `trace.cpuprofile`. The manifest lists shared-process, filesystem and Git inspector profiles; these processes are also profiled by Chromium. The analyzer retains one profiler per traced thread, avoiding duplicated totals.

The workspace configuration and package paths in the capture point to `about-view`. The command described in the request may have used a linked `packages/about-view` checkout. The current monorepo no longer has that path, so experiments explicitly use `lvce-editor/about-view` and its `packages/about-view/src/aboutWorkerMain.ts` file.

## Evidence from the supplied capture

| Thread/work | Approximate sampled time | Interpretation |
| --- | ---: | --- |
| ESLint module resolution, non-idle | 46.0 s | Largest contributor; about 40.7 s originally attributed directly to its bundle |
| ESLint extension, non-idle | 10.5 s | Content caching, hashing, compression and RPC |
| ESLint evaluation, non-idle | 7.0 s | Module evaluation and lint config initialization |
| Filesystem process, non-idle | 4.2 s | Serialization, RPC, stat/hash operations |
| Shared process, non-idle | 1.2 s | Most active in the first four seconds; many ESM imports and filesystem operations |
| Main process, non-idle | 0.7 s | Predominantly idle; some profiler shutdown work is included |
| Renderer process, non-idle | 0.2 s | DOM work is comparatively small |

These are sample-residency estimates, not OS CPU measurements. Time under different threads can overlap. The original trace contains negative sample deltas and occasional long gaps; the parser preserves accumulated timestamps and sorts samples before assigning intervals. Do not interpret every millisecond as precise.

The ESLint resolver starts about four seconds into the trace and dominates the remaining startup-to-diagnostics interval. Its `transpileUncached` subtree accounts for about 24.7 seconds inclusive; Babel transformation accounts for about 15 seconds within that. Cache writes, AST dependency walking, path normalization and GC are also substantial. The evaluation worker does most of its meaningful work late in the capture, after module graph construction, which shows a producer/consumer dependency rather than freely parallel work.

No separate TypeScript language-features worker appears in this capture. The `typescript.js` stacks present here are loaded through ESLint's plugins/parser. This trace supports prioritizing ESLint; it does not establish a TypeScript extension bottleneck.

## Candidate changes

In `lvce-editor/eslint`, branch `feature/startup-performance`:

- Reuse the AST already parsed for dependency analysis in Babel's `transformFromAst`; disable cloning because the tree is not reused after transformation.
- Traverse Babel's syntax-node visitor keys instead of recursively enumerating all object properties, including location metadata and comments.
- Avoid regular-expression normalization and path splitting for already normalized paths, retaining the original fallback for dot segments, URI and Windows paths.
- Count/reserve modules once instead of enumerating every previously loaded module for each new module. This removes quadratic bookkeeping and keeps the module limit effective across concurrent asynchronous visits.

The AST changes passed all 81 resolver tests. Fresh Node processes against the same current `about-view` workspace produced identical hashes for the 4,325-module graph, with 5,471 reads of 5,213 distinct files and approximately 40.35 million source characters. Three alternating runs of the AST-only candidate reduced median graph duration from **18.775 s to 16.668 s (11.2%)**. This harness excludes browser storage, IPC and Electron startup. One preliminary baseline overlapped a build and is excluded from the repeated results.

An initial browser pair measured **36.38 s baseline and 36.47 s AST-only candidate**. That does **not** demonstrate an end-to-end improvement. One candidate launch failed with `ERR_INSUFFICIENT_RESOURCES` before measurement; the successful retry used a temporary directory on the home filesystem rather than `/tmp`. Repeated CI measurements are needed to distinguish effects and variation. The browser harness's explicit lint command follows opening the file and can reuse work from automatic diagnostics; its approximately 23 ms command duration is not cold ESLint initialization time.

The combined AST and module-counter candidate measured 15.49, 15.84 and 16.14 seconds (median **15.84 s**, about **15.6%** below the three-run baseline). These later runs are not fully interleaved with the baseline, so CI is the stronger comparison. Every graph hash remained identical. Direct native Node ESLint loading plus linting measured **4.10 s** with no errors or warnings, indicating a potentially larger architecture opportunity; it is not a like-for-like editor startup result. Memory measurements at arbitrary process exit fluctuate with GC/allocator state. Forced-GC and peak-RSS observations are retained to check for material regressions; this investigation does not authorize raising memory budgets.

## Further experiments ranked by likely value

1. **Reduce config graph breadth.** The shared `@lvce-editor/eslint-config` statically imports plugins for Markdown, Jest, package JSON, YAML, spelling, TypeScript and more even when opening one ordinary source file. A file-specific config entry or lazy plugin/rule loading could avoid much more work than parser tuning. Preserve exact flat-config ordering, matching and rule results, and retain support for dynamic configuration; textual import pruning is unsafe.
2. **Reduce synchronous persistent-cache work on the diagnostics path.** The capture spends seconds in `setCachedValue`, `setText`, hashing, response construction and compression. Test batched storage, threshold choices and background persistence with bounded concurrency. Compare genuinely cold starts and warm reloads; abandoning writes at shutdown can make the next launch slower, and unbounded background writes can increase memory.
3. **Native desktop ESLint execution.** Direct Node evaluation avoids building/transpiling a portable graph for thousands of modules. A prototype measurement is included as an architecture comparison, not a production fix. Any implementation should use the established extension helper process, preserve project-local ESLint and plugins, cancellation and error reporting, and keep the browser path available. Differences in sandbox/trust and runtime semantics require an explicit design decision.
4. **Shared-process packaging and startup sequencing.** The production build currently sets `bundleSharedProcess = false`, and early stacks show Node ESM loading. Test a bundled or split-bundle build and overlap independent preference/settings/worker initialization where dependencies permit. Existing build branches rewrite paths and copy worker artifacts, so simply flipping the flag is not sufficient validation. Its absolute opportunity is substantially smaller than ESLint's in this capture.
5. **Filesystem RPC batching.** The filesystem utility spends noticeable time posting messages, serializing hash caches and hashing files. Batch compatible reads/stat/hash requests or reuse validated metadata within one graph load. Keep change/invalidation detection correct and compare response size and peak memory.
6. **Worker launch policy.** Twenty browser workers are created here and many do very little work. Measure worker creation, compilation and memory independently before deciding to launch fewer eagerly. Do not serialize the few genuinely independent startup tasks or delay visible features merely to improve a diagnostics-completion number.

## Measurement gaps

Add stable milestones for process entry, `appReady`, first useful editor paint, open-file/text readiness, extension activation, config graph readiness, first diagnostics and cache flush completion. Include `blink.user_timing` in the Electron trace and retain a result JSON with these milestones. The present trace starts after `app.whenReady` and contains no app user-timing marks, so it cannot establish full process startup or first usable text latency.

Use an unprofiled readiness benchmark alongside profiles, fixed commits/lockfiles and runtime versions, alternating runs on one runner, and separate cold/warm application state. The GitHub Actions workflows in this repository retain per-worker overview JSON, profiles and failure logs for those comparisons. Fresh application state does not imply cold OS disk caches.

## Repeated CI results and fresh TypeScript evidence

[The three-run ESLint experiment](https://github.com/lvce-editor/performance-investigations/actions/runs/37191427553) compared baseline `89c48abd` with AST/counter candidate `141b2da3`, before the final path fast paths. Median direct graph construction fell from **12.309 s to 10.531 s (14.4%)**. Profiled cold browser test-overlay readiness fell from **46.018 s to 43.920 s (4.6%)**. Warm reload stayed approximately **1.909 s**. The independent warmup without profiling was approximately 25.06 s versus 23.60 s, but the dedicated fixed-harness unprofiled experiment is the preferred confirmation. Full timings are retained in `eslint-ci-profile-overview.json`.

[Isolated official Electron release captures](https://github.com/lvce-editor/performance-investigations/actions/runs/37191429077), using fresh XDG/Chromium state and the pinned workspace, reveal a TypeScript worker absent from the supplied recording. Roughly **45 seconds** are sampled inside synchronous `invokeSync` filesystem RPC. This includes blocked **Atomics.wait**, so calling it TypeScript CPU would be misleading. Reducing those requests may also reduce contention with ESLint and the filesystem process.

The request-scoped experimental candidate in [closed PR 706](https://github.com/lvce-editor/language-features-typescript/pull/706) caches repeated existence checks and file reads only during one synchronous diagnostics request, discarding the cache in `finally`. False and undefined values are cached; exceptions and mutable directory results are not. A real resolver/diagnostics experiment with direct Node filesystem transport reduced initial underlying requests from **22,947 to 4,982 (78.3%)**, including existence checks from 19,971 to 4,168 and reads from 2,878 to 716. Both returned the same diagnostics hash. Introducing a type error and restoring the document produced identical results across variants; focused tests verify request boundaries, separate clients and exception cleanup. These counts are promising transport evidence, not a startup speed claim. The three-request edit experiment counts subsequent requests too and stores its initial counts separately.

The TypeScript Electron workflow builds both source refs, injects their worker and matching TypeScript libraries into separate copies of the **same** official release, and verifies identical extension lockfiles. Application activation code, other extensions, workspace and runtime stay fixed. This is an experimental asset override; it does not represent a published extension integration. It retains provenance hashes, alternating captures, request counts and per-worker overview JSON.

The normalized fresh-release profile is retained in `official-release-summary.json` and `official-release-timeline.svg`. Its activity timeline shows TypeScript and ESLint overlapping; their sampled times must not be added to predict elapsed startup.

## Final ESLint patch without profiling

[The fixed-harness readiness experiment](https://github.com/lvce-editor/performance-investigations/actions/runs/37193004666) compares baseline `89c48abd` with final candidate `e45e37b4`. Three alternating runs on one runner reduced median cold readiness from **25,140.1 ms to 23,601.9 ms (6.1%, 1.54 seconds)**. Warm reload changed from 1,372.2 ms to 1,367.7 ms (0.3%), too small to call a material gain. Every candidate cold run was faster than every baseline cold run. The result includes opening the file and completing the benchmark's lint test, using fresh browser state and warm OS filesystem caches. It is not Electron process-entry-to-paint latency.

[ESLint PR 152](https://github.com/lvce-editor/eslint/pull/152) is merged after passing the full Linux/macOS/Windows validation matrix, including existing memory checks. Release `v1.24.1` carries the optimized code. [Application update PR 15680](https://github.com/lvce-editor/lvce-editor/pull/15680) is merged after Linux, macOS, Windows x64 and Windows ARM64 checks passed, with the released archive checksum verified. The complete raw readiness measurements are retained in `eslint-ci-readiness-overview.json`.

## Where the config graph grows

`eslint-package-breakdown.json` groups all resolver reads, including repeated reads and package metadata. TypeScript accounts for about **12.95 million source characters (32.1%)** of the 40.35 million total. SonarJS contributes **1,185 reads / 3.08 million characters**, Unicorn **507 / 2.43 million**, ESLint **380 / 2.67 million**, and the common-misspellings dictionary **2.08 million characters**. These are input-volume counts, not package CPU attribution. They explain why reducing unnecessary plugin and dictionary initialization or using a native desktop config loader has a larger potential than another small path micro-optimization. Loading only applicable plugins must preserve configuration semantics; silently dropping enabled rules is not an optimization.

## Consolidation with existing TypeScript work

[Existing PR 703](https://github.com/lvce-editor/language-features-typescript/pull/703) already implements caching of identical filesystem queries during synchronous work, expiring them in a microtask before another task runs. It additionally covers language-service commands outside diagnostics and counts actual transport calls in its performance trace. The new request-scoped alternative is closed rather than installing two overlapping caches. Its commit and measurements are retained as experimental evidence.

PR 703 was refreshed by a normal merge of current main, producing `5a6dc834`, with the same lockfile as baseline `69ed696e`. The Node diagnostics/edit experiment confirms the same initial **4,982 underlying requests**, the same two diagnostics after introducing the type error, and zero after restoring the document. `typescript-existing-cache-edits.json` records this exact source SHA and TypeScript version. A separate alternating Electron workflow now measures this actual integration candidate.

The previous PR 703 CI passed Linux and macOS but failed one Windows Firefox Problems-panel assertion (`property-before-initialization`: expected two rows, observed zero). The failure is preserved in run `37187038188`; the separate existing PR 704 investigates delayed diagnostic readiness. Updating the base or a passing rerun does not establish that this timing issue is fixed. The full current-head validation matrix must pass before merging the optimization.

## Electron result for the request-scoped alternative

[The three-run request-scoped Electron experiment](https://github.com/lvce-editor/performance-investigations/actions/runs/37193115073) completed successfully. Median TypeScript sampled non-idle time fell from **49.50 s to 17.46 s (64.7%)**; median whole-trace duration fell from **65.67 s to 60.54 s (7.8%)**. One representative run reduced `invokeSync` self residency from 45.70 s to 11.38 s. These samples include blocking transport waits; the trace covers diagnostics and profiling overhead, not first paint. ESLint still dominates the end of the capture. This measures the now-closed alternative, so PR 703 is being measured independently before claiming the same result for its implementation. `typescript-request-scope-electron-overview.json` retains each run's values and exact refs.

## Electron validation of the consolidated TypeScript candidate

[The PR 703 Electron experiment](https://github.com/lvce-editor/performance-investigations/actions/runs/37193655550) compared `69ed696e` with `5a6dc834` on one runner for three alternating runs. Median TypeScript non-idle sample residency fell from **25.08 s to 8.00 s (68.1%)**. Median `invokeSync` self residency fell from **21.55 s to 4.89 s (77.3%)**. Median whole-trace duration fell from **38.49 s to 34.54 s (10.3%)**. Every candidate TypeScript run was faster than every baseline run. The source refs use identical lockfiles and TypeScript 6.0.3; worker hashes and lockfile hashes are retained in `typescript-ci-provenance.json`.

This independently validates the implementation proposed for integration, rather than relying on the closed alternative. Absolute times differ substantially from the earlier experiment's runner, so compare variants within each run and do not compare the two candidates across runners. The whole trace includes diagnostics, profiling and shutdown; it does not measure first usable paint. These results also show that reducing TypeScript blocking leaves the ESLint graph as the main remaining tail. Raw per-run values are in `typescript-ci-electron-overview.json` and Node edit/request results in `typescript-ci-*-requests.json`.

## Visual startup in the original trace

The recording contains generic Chromium paint metrics even though application-specific user-timing marks are absent. Relative to the earliest CPU profiler start, first paint occurs at **812 ms**, first contentful paint at **2,130 ms** (the title-bar title), and a main-frame largest-contentful-paint candidate names **`DIV class='EditorRow'` at 3,548 ms**. This establishes that editor text is painted well before the approximately 68-second diagnostics tail; it does not establish keyboard-input readiness or process-entry-to-paint time. `original-browser-milestones.json` preserves the frame, navigation and node metadata, and the analyzer now exports these browser milestones for future comparisons.

For optimizing the first visible editor, profile the missing pre-`appReady` interval and independently compare shared-process bundling/initialization. In the observed first five seconds, shared-process non-idle residency is about **1.10 s**. Node module loading accounts for about **0.24 s inclusive**, while JSON parsing, filesystem reads/open/stat calls and message posting also contribute. This is a smaller but earlier opportunity than extension diagnostics. Inclusive module-loader rows overlap and cannot be added. The editor-worker/renderer CPU samples are comparatively small. These findings prioritize targeted startup measurements rather than treating the full diagnostics tail as time until the editor appears.

## Main-process work before app readiness

[An early inspector capture](https://github.com/lvce-editor/performance-investigations/actions/runs/37195265714) starts profiling before application JS executes, covering the interval missing from the standard trace. Over the first ten seconds it records **365 ms non-idle main-process sample residency**, including about **65 ms in debugger startup/pause machinery**. Window creation contributes about **129 ms self / 142 ms inclusive**, built-in module compilation about 32 ms self, and application ESM source compilation about 7 ms self. This one profiled run suggests that main-process JS is a smaller opportunity than the extension graph/RPC work; it does not measure native Electron startup CPU or establish a stable unprofiled latency.

The existing main-process marks were successfully exported: `code/start` 283 ms, `code/appReady` 1,197 ms, shared-process launch 1,197→1,371 ms, window creation 1,394→1,461 ms, and URL loading 1,527→1,608 ms relative to Node's performance clock. The debugger had paused before application entry until performance.now()≈236 ms, and native Electron initialization may continue while paused. These numbers describe this instrumented launch and should not be substituted for normal launch timings. The capture validates isolated child XDG paths before resuming application code. `early-main-summary.json` and `early-main-marks.json` retain the evidence.

TypeScript PR 703 subsequently passed every current-head platform/browser job and merged at `4294e8a0`. Release tag `v5.28.1` points to that merged commit; its release workflow is being monitored before application integration. The earlier Windows timing failure remains historical evidence, not a claimed independent flake fix.
