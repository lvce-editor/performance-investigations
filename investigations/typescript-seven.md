# TypeScript 7 versus LVCE's TypeScript extension

LVCE's optimized TypeScript extension is substantially slower than TypeScript 7 on this about-view fixture. The latest comparison measured cold diagnostics at **6.148 seconds versus 0.138 seconds**, with a median paired ratio of **44.9×**. Warm operations are also much slower because LVCE validates its filesystem cache before each request. This is a measured integration gap as well as a compiler-speed gap.

The [benchmark PR](https://github.com/lvce-editor/performance-investigations/pull/5), CI runs [1](https://github.com/lvce-editor/performance-investigations/actions/runs/37368589522), and [machine-readable results](typescript-seven.json) preserve provenance and individual timings. Full traces, source graphs, logs and harness instrumentation are retained in workflow artifacts for 90 days.

## Controlled setup

- TypeScript **6.0.3** in LVCE and the direct Node host; native TypeScript **7.0.2** for CLI and LSP.
- LVCE extension commit `15051b0798c49df044e1e8b0aec63c56f7169855`, including the merged directory metadata optimization (#711).
- About-view commit `15fe112cf4b82ab72eaa6d29589aede9e53d96d4`; `packages/about-view/tsconfig.json`, opening `packages/about-view/src/aboutWorkerMain.ts`.
- Node **24.15.0**, Ubuntu **24.04**, **4 logical CPUs** (AMD EPYC 7763 64-Core Processor).
- Five alternating-order repetitions per run, fresh processes and Chromium/XDG state per cold sample. OS filesystem caches are retained. Timed requests are unprofiled.

The extension runs in real headless Chromium with LVCE's server and actual filesystem IPC. Only the TypeScript extension is enabled. Harness-only commands forward to its existing diagnostics, completion and reference worker entry points; they do not open a performance-report editor. The activation source and manifest instrumentation are archived. Compiler, resolver, worker and filesystem production logic are unchanged.

Each service trial requests cold diagnostics, five unchanged diagnostics, five edit/restore pairs, five completions and five reference searches. The edit appends `const startupPerformanceError: string = 123; void startupPerformanceError` in memory. Every edit produces the expected type error, every restore clears it, and the original file on disk is never changed. Completion at `Main.main` produces the same `main` label in all three services. Reference search produces the same four locations, including the implementation and test usages. First and repeated completion/reference requests are reported separately.

Both CLI compilers enumerate **731 files**. The **643 non-library project/dependency paths** match, with content hashes recorded from the shared workspace. The direct TS6 and LVCE service graphs match those non-library paths in every trial and select 145 configured roots. TS7 LSP confirms the same package tsconfig. Its internal source graph is not separately enumerated through LSP; matching CLI graphs, project selection and reference/diagnostic results are the available checks. Compiler library contents can differ between TS6 and TS7.

## Language-service measurements

All values below are **milliseconds**. Each trial contributes a median for repeated requests; the table then takes the median across five trials. The ratio column takes the median of per-trial LVCE/TS7 ratios, so it can differ slightly from the ratio of the table medians.

| Operation | TS6 direct Node host | LVCE TS6 extension | TS7 native LSP | Paired LVCE / TS7 |
|---|---:|---:|---:|---:|
| Cold diagnostics | 970.20 | 6148.01 | 138.48 | 44.9× |
| Unchanged diagnostics | 0.009 | 1096.65 | 0.333 | 3430.5× |
| Diagnostics after adding a type error | 27.29 | 2368.41 | 2.05 | 1155.7× |
| Diagnostics after restoring text | 24.25 | 2373.82 | 1.71 | 1390.6× |
| First completion after diagnostics | 6.26 | 1143.23 | 1.42 | 817.8× |
| Repeated completion | 0.345 | 1082.07 | 0.348 | 3132.0× |
| First project reference search | 14.87 | 1115.05 | 4.16 | 269.0× |
| Repeated reference search | 6.39 | 1109.55 | 1.99 | 553.9× |

Cold TS6 host timing includes config/program construction but excludes loading the compiler module. Cold TS7 timing starts immediately before `didOpen` and ends at the complete pull-diagnostic response, after LSP initialization; launch through diagnostics takes a median **147.98 ms**. LVCE timing includes the extension command round trip and cold activation. Browser/server startup and editor rendering are excluded. Worker-only diagnostic timings are retained separately. These are language-feature request timings, not full application launch-to-UI-readiness measurements.

TS6 requests semantic diagnostics; native pull diagnostics can also include syntactic diagnostics. An unchanged TS6 API call can be cheaper than a native LSP round trip: caching already makes its compiler work essentially free. That does not explain LVCE's much larger warm cost.

| Independent CI comparison | LVCE cold, ms | TS7 cold, ms | Paired cold ratio | LVCE edited, ms | TS7 edited, ms |
|---|---:|---:|---:|---:|---:|
| [Run 1](https://github.com/lvce-editor/performance-investigations/actions/runs/37368589522) | 6148.01 | 138.48 | 44.9× | 2368.41 | 2.05 |

Absolute times vary with the runner. Runs are reported separately rather than pooled. The harness rejects output directories containing old incremental state before launching any timed CLI command. This guard was added after the first CI run; the first run already used a fresh checkout and fresh state files.

## Whole-project CLI checking

The CLI checks all configured source/declaration files, while the language services request diagnostics for the opened file. Do not compare their times as identical workloads. Each CLI invocation uses fresh incremental state despite the composite project setting, with `--noEmit --extendedDiagnostics` and a unique `--tsBuildInfoFile`. Node/npm launcher overhead is not hidden: these timings include the Node compiler or Node native-executable wrapper, but exclude `npx` startup.

| Compiler | Median process elapsed | TS6 / compiler |
|---|---:|---:|
| TS6 JavaScript | 2.886 s | 1.0× |
| TS7 native, default parallelism | 0.565 s | 5.11× |
| TS7 native, `--singleThreaded` | 0.724 s | 3.99× |

Native code still has a substantial advantage with threading disabled. Default parallelism adds a further 1.28× speedup on this small configured project. This does not establish a universal speedup for larger projects.

## Where LVCE loses time

For unchanged diagnostics, the latest runner measured **1071.41 ms** in language-service lookup/cache validation and only **0.060 ms** in semantic diagnostics. The existing service is reused. For the edited document, the corresponding stages are **1062.94 ms** and **1253.59 ms**. The latter stage includes host filesystem work; it is not isolated compiler CPU time.

`GetOrCreateLanguageService` calls `client.refresh()` before returning a cached service. `CachedFileClient.refresh()` rechecks known content identities in a batch, then individually checks missing paths and directory listings. Its work occurs before the traced client is created, so the warm trace's zero `syncRpc.callCount` does not mean zero filesystem IPC. Warm cache counters and wall times are retained in the raw artifacts and compact JSON. No CPU profile was taken during these timings.

The next concrete optimization is **batching warm validation of the already-known missing paths and directories**, or using reliable filesystem change generations/watch invalidation to avoid unnecessary full validation. Those paths are known from the existing cache; this does not require predicting which new files TypeScript will probe later. Correctness must still cover external file creation, removal, dependency changes and all supported providers. Improving the edit-stage host work is another target.

Adopting TS7's native language server could also reduce compiler work and benefit from its project/watch infrastructure. This experiment measures a standalone server with direct disk access; it does not implement or establish LVCE support for remote, memory or browser-only filesystems. Reducing our integration overhead remains valuable even if we later adopt TS7.

## Reproduction

Run the **TypeScript 7 comparison** workflow, or install/build the pinned extension and fixture, install `typescript@7.0.2` in a separate prefix, then use the scripts below. Use a new output directory on every invocation:

```sh
node src/typescript-seven-prepare.ts /path/to/extension results/instrumentation
# Build the instrumented extension with its existing npm run build command.
node src/typescript-seven-experiment.ts /path/to/extension /path/to/about-view /path/to/native-prefix/node_modules/typescript results 5
```

The prepare script changes only the disposable extension checkout's activation source and manifest. Keep that checkout isolated and preserve the original/instrumented files from the output artifact.
