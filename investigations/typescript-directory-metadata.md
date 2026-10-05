# TypeScript directory metadata snapshots

The directory snapshot experiment reduces repeated synchronous metadata round trips without predicting which filename TypeScript will request next. It keeps one directory's entry names locally during a synchronous job and uses them to disprove missing sibling names. The benchmark has consistently reduced traced calls and improved warm diagnostics; cold timing varies with the runner and file-read costs.

Source PR: [language-features-typescript #711](https://github.com/lvce-editor/language-features-typescript/pull/711). Benchmark tooling: [typescript-benchmark #14](https://github.com/lvce-editor/typescript-benchmark/pull/14). [Machine-readable measurements](typescript-directory-metadata.json) preserve provenance, medians, paired changes, individual trials and method timings. Raw CPU profiles and full traces accompany the linked workflow artifacts.

## Implementation

The existing request cache deduplicates identical existence/read requests. This patch additionally remembers configuration directory enumerations and, after a second distinct existence probe in an unlisted directory, requests its names with the existing `SyncApi.readDirSync` endpoint. One response can answer many subsequent missing `.ts`, `.tsx`, `.d.ts`, `.js` or package-name probes in that directory.

A listed name still uses the exact existence check: a symlink can be present but dangling. ASCII names are compared case-insensitively, which avoids false negatives on case-insensitive disks and merely causes additional exact checks on case-sensitive providers. Escaped or unusual URI names, Unicode names, Windows alias spellings, unsafe/oversized listings and failed enumerations conservatively use exact queries. The inference limit is 1,024 entries. Empty and drive-relative directory names cannot seed absolute-root snapshots.

The maps clear in a microtask before another task executes, matching the original request cache's lifetime. The persistent file-content adapter already remembers directory identities and rechecks them when deciding whether to retain a language-service program. Inferred negatives therefore replace many individually revalidated missing paths with directory validation. Existing file/memory filesystem tests cover source/dependency changes, removal and recreation, unsaved text and warm cache reuse. New unit tests cover sibling misses, expiry, listing failures, symlinks, case variants, URI/provider boundaries and conservative fallback cases.

## Experiment

The source comparison runs in `lvce-editor/typescript-benchmark`, using its real isolated Electron launcher. Both variants override the bundled extension with source-built artifacts. The baseline is `76761b0847cc4ff4dddf8b841a9ab0ba7a2f5f55`; the final candidate is `ae61dd465b7de7e98585bf4326d15689720497de`. Early runs used intermediate candidates with the same ordinary-project behavior while safety guards and test typings were refined.

Every run alternates baseline/candidate order across five pairs, with fresh Chromium and XDG state for every launch. It pins LVCE `v0.120.7`, TypeScript `6.0.3`, Node `v26.10.0` and about-view `15fe112cf4b82ab72eaa6d29589aede9e53d96d4`, opening `packages/about-view/src/aboutWorkerMain.ts`. Dependency lock hashes must match. All variants loaded the same 731 filenames and source byte sizes and returned zero diagnostics for the opened file. Fixture, compiler and built-extension digests are recorded separately; loaded-file equality is not itself a source-content hash comparison.

Cold duration is the first diagnostic trace's total worker operation. Readiness separately measures launch until the validated cold trace returns. Ten unchanged-document warm requests are timed without profiling; separate cold/warm CPU captures follow the existing harness. Disk page caches are retained. Within each runner, the report computes a percentage change for each adjacent pair and takes its median; it does not pool absolute times from different runners. Median warm time first aggregates the ten requests within each fresh trial, then the five trials.

| CI run | Cold median baseline → candidate | Paired cold change | Warm median baseline → candidate | Paired warm change |
|---|---:|---:|---:|---:|
| [37320826177](https://github.com/lvce-editor/typescript-benchmark/actions/runs/37320826177) | 19.542 → 15.773 s | -19.3% | 0.658 → 0.607 s | -7.9% |
| [37321149426](https://github.com/lvce-editor/typescript-benchmark/actions/runs/37321149426) | 9.654 → 9.643 s | -3.7% | 0.654 → 0.467 s | -28.5% |
| [37321858865](https://github.com/lvce-editor/typescript-benchmark/actions/runs/37321858865) | 12.725 → 11.533 s | -9.4% | 1.429 → 1.047 s | -27.7% |
| [37322753981](https://github.com/lvce-editor/typescript-benchmark/actions/runs/37322753981) | 12.899 → 11.923 s | -7.1% | 1.386 → 1.001 s | -27.8% |
| [37324041413](https://github.com/lvce-editor/typescript-benchmark/actions/runs/37324041413) | 12.892 → 11.725 s | -7.4% | 1.425 → 1.054 s | -27.0% |

Negative changes mean faster. Five pairs per run give 25 pairs overall, with evolving candidate safety guards; the final row validates the exact final candidate. Absolute medians and medians of paired percentage changes answer different questions and need not agree numerically.

Every completed run reported these same cold trace counts:

| Traced method | Baseline | Candidate | Difference |
|---|---:|---:|---:|
| `SyncApi.exists` | 4,627 | 3,034 | −1,593 (−34.4%) |
| `SyncApi.readDirSync` | 98 | 496 | +398 |
| `SyncApi.readFileSync` | 716 | 716 | 0 |
| Total | 5,441 | 4,246 | −1,195 (−22.0%) |

These are calls recorded by the worker's traced client, not OS stat/read syscall counts or a complete count of nested IPC. In particular, the persistent content adapter's hashing requests occur inside traced reads, and warm revalidation RPCs are not completely enumerated by the existing trace. The external warm stopwatch includes that work.

## Attribution and memory

Fewer traced calls are repeatable; the full cold timing change is less uniform. On the first runner, median traced file-read duration fell from 16.08 to 12.44 seconds even though the read count remained 716. That large component cannot all be attributed confidently to this metadata patch. On the second runner, exists plus directory-listing medians fell by about 337 ms, while file reads became about 183 ms slower; the overall cold medians were nearly equal despite a 3.7% improvement in median paired changes. On the third, exists plus listings fell by about 560 ms and file reads by about 685 ms. Inclusive callback timings overlap other stages and should not be summed as independent CPU work.

Post-profile heap without explicit GC initially appeared 16–22 MB larger on two runners, then 18 MB smaller on a third. A separate retained-heap reading after explicit worker GC established that this was largely temporary allocation/GC timing. On run 37322753981, median retained V8 heap was 57,691,128 bytes baseline versus 57,725,508 candidate: +34,380 bytes, about 0.06%, with paired differences of 17,908–45,080 bytes. GC runs after all timed/profiled requests, so it does not affect readiness or diagnostic timings. This is retained JS heap, not peak allocation or RSS; no memory limit was increased.

The final candidate comparison also measured retained heap: 57,694,504 bytes baseline versus 57,716,760 candidate, +22,256 bytes (about 0.039%). Its readiness medians were 15.341 seconds versus 14.084 seconds. The benchmark tooling PR passed tests on Linux x64/ARM, Windows and macOS, its existing official-editor benchmark, and the source comparison before merging. The source optimization is configured to merge only after all three required OS jobs, including their browser regressions, pass.

## Remaining opportunities

Listings add work and cannot be assumed cheaper for every provider or workload. The adaptive second-probe threshold and listing-size bound avoid some unnecessary enumeration, but future tuning should compare different project shapes, large dependency directories and remote providers. Ordinary file reads still dominate several cold captures. The persistent content cache fingerprints files through its hashing API before reading misses, so profiling that read/hash path is the next concrete cold-start target. This patch does not change hashing, file content reads, URI identity mapping or the underlying synchronous response transport.
