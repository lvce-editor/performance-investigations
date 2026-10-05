# LVCE performance investigations

Analyze Electron/Chromium startup traces and V8 CPU profiles, run repeatable experiments, and retain machine-readable results. Requires Node 24; the analysis tools have no npm dependencies.

```sh
npm ci
npm test
npm run analyze -- /path/to/lvce-cpu-capture summary.json
npm run analyze -- trace.cpuprofile first-five-seconds.json 5000
npm run compare -- baseline-summary.json candidate-summary.json comparison.json
npm run capture -- /usr/bin/lvce /path/to/workspace relative/file.ts results/run-1
```

`trace.cpuprofile` can contain Chromium `traceEvents`, despite its suffix. The analyzer also accepts ordinary V8 `nodes`/`samples` profiles. It reconstructs incremental `ProfileChunk` events by process and profile ID, uses the original profiling thread rather than the chunk writer thread, and removes duplicate simultaneous inspector/Chromium utility recordings. The original capture's manifest refers to `trace.json`, which was renamed to `trace.cpuprofile`; directory input handles that case.

Schema version 2 identifies functions by name, URL, line and column, keeping distinct functions in minified bundles separate. Older retained measurements use version 1 labels; worker totals are unchanged.

Outputs include self and inclusive function timings, source-file totals, GC/idle/unattributed time, worker profiling start times, a one-second activity timeline, and Chromium paint/LCP milestones when available. Paint milestones retain frame and node metadata: painting a title or an editor row does not establish full input readiness. Query parameters, development server ports and common local checkout prefixes are normalized. Standalone utility profiles can be analyzed individually; **do not add their totals to a Chromium trace that already contains those same utility processes**.

Timings represent timestamp-ordered **sample residency**, not measured OS CPU time. V8 emits some out-of-order samples; negative deltas are retained when constructing timestamps, then samples are sorted. The gap before the first sample is unobserved. Long sampling gaps are counted; native calls and blocking work can affect attribution. Recursive frames contribute once per sample to their inclusive row. Inclusive rows overlap and must not be summed.

A profile capture ending at diagnostics readiness is different from first paint or time to usable text. The Electron trace starts after `app.whenReady`, so it misses earlier Electron startup/module evaluation. Capture metadata includes launch-to-exit time separately from trace time and analysis time. Fresh XDG and Chromium directories isolate application state; OS filesystem caches remain uncontrolled. Profile artifacts can contain workspace paths and source metadata. The checked-in original findings contain normalized summaries, not the original user-data or trace contents.

## Experiments

[Electron startup profiles](https://github.com/lvce-editor/performance-investigations/actions/workflows/startup.yml) compares official Debian release tags on one Linux runner. Each run starts with isolated application state. Variant order alternates across repetitions. It preserves profiles and summaries without installing either package into the runner's system.

[ESLint startup experiment](https://github.com/lvce-editor/performance-investigations/actions/workflows/eslint.yml) checks out two explicit `lvce-editor/eslint` refs and a fixed `about-view` workspace commit. Both variants are built before measurements. It measures graph construction in Node, fresh-browser startup, and warmed renderer reload on one runner. Each result contains a profile summary and timings; the workflow produces an overview JSON and a Markdown table. The existing ESLint benchmark harness waits for its test overlay and explicitly invokes lint after opening the file; its reported lint-command duration may reflect a graph already initialized by automatic diagnostics. Prefer the full cold-run duration for evaluating cold graph initialization.

[TypeScript Electron startup experiment](https://github.com/lvce-editor/performance-investigations/actions/workflows/typescript.yml) compares worker refs in isolated copies of one fixed official Electron release. It also checks filesystem request counts and document edits. Provenance includes worker and lockfile hashes; it rejects differing lockfiles.

[Released extension startup experiment](https://github.com/lvce-editor/performance-investigations/actions/workflows/extensions.yml) installs exact published ESLint and TypeScript extension archives into isolated copies of one fixed runtime. It validates available asset digests and records release provenance, allowing combined release experiments without a full application rebuild.

ESLint experiments can run `profiles`, `readiness`, or `both`. The readiness mode uses the same baseline harness for both variants and disables profiling.

[Early main-process startup profile](https://github.com/lvce-editor/performance-investigations/actions/workflows/main-startup.yml) attaches an inspector before application JavaScript runs, captures its first ten seconds, and exports the existing main-process performance marks. It includes pre-`appReady` JS missing from the regular Chromium capture. Debugger pauses perturb timing; use it to identify work, then validate timing without the debugger.

Each experiment publishes a small overview artifact retained for 90 days, alongside larger raw profiles retained for 14 days. Use the overview for routine comparisons and download traces for deeper diagnosis.

For these workflows, use at least three repetitions and compare distributions, not one run. For source experiments, use full 40-character commit hashes or existing branch/tag names; abbreviated hashes are treated as ref names by Actions checkout. Keep workspace, lockfile, Electron/Chromium version, runtime settings and machine class identical when isolating a code change. Release comparisons can change several dependencies together and establish a release difference, not causality for one patch. Profiling overhead can amplify differences; confirm meaningful changes with an unprofiled readiness benchmark before calling them product startup gains.

The Node graph experiment is also available directly:

```sh
node --expose-gc src/graph-benchmark.ts /path/to/eslint-checkout /path/to/workspace graph.json
```

It uses direct filesystem reads and no browser cache storage or IPC. The graph hash permits exact producer-output comparison between variants. It does not measure end-to-end startup.

An optional activity heatmap can be regenerated with `python3 scripts/plot-activity.py summary.json timeline.svg` (requires NumPy and Matplotlib). The [original timeline](investigations/original-timeline.svg) shows where the long ESLint tail occurs.

See [the initial investigation](investigations/startup.md) for hotspot evidence, measurements and optimization priorities.

See [the TypeScript 6 comparison](investigations/typescript-cli.md) for CLI versus Node-host and real browser IPC measurements.

The **TypeScript CLI and extension comparison** workflow pins the compiler and about-view workspace, checks matching source graphs, and measures whole-project `tsc`, one-file diagnostics with the standard Node host, the LVCE host with direct Node filesystem access, and the real browser extension with IPC. It saves unprofiled repetitions separately from CPU profiles. Run the Node comparison locally with:

```sh
node src/typescript-cli-experiment.ts /path/to/language-features-typescript /path/to/about-view results/typescript-cli 5
```

Both checkouts need `npm ci` and the same TypeScript version. Browser measurements additionally need `npm run build` and `npx playwright install --with-deps chromium` in the extension checkout:

```sh
node src/typescript-browser-benchmark.ts /path/to/language-features-typescript /path/to/about-view results/typescript-browser 5
```

See [TypeScript resource identities](investigations/typescript-path-identities.md) for URI compatibility, escaping probes and a provider-mounted compiler-path prototype. The **TypeScript path identity experiment** workflow compares four standard language-service hosts with identical source graphs and saves repeated timing results and resolver traces.

See [directory metadata snapshots](investigations/typescript-directory-metadata.md) for the real Electron experiment reducing TypeScript existence probes and improving cold/warm diagnostics. Measurements include paired timing results, traced method counts and GC-normalized retained heap.
