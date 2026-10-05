# TypeScript resource identities

Keep resource URIs at LVCE's public and filesystem-provider boundaries. Inside the TypeScript adapter, use one consistent filename representation. A memoized, provider-aware compiler-path mapping is a promising correctness design; the benchmark below tests its cost, rather than assuming it makes startup faster.

## What TypeScript actually does

TypeScript 6.0.3 recognizes arbitrary `scheme://authority/` roots. Its directory, ancestor and normalization helpers preserve URI-shaped filenames. It does not inevitably convert file URIs into disk paths. Its [path implementation](https://github.com/microsoft/TypeScript/blob/v6.0.3/src/compiler/path.ts) performs lexical path operations and expects the host to interpret the resulting strings.

The production LVCE adapter currently performs the conversion itself: [`resolveModuleNameWithTypeScript`](https://github.com/lvce-editor/language-features-typescript/blob/c7434ae2cc7d89f5e178f84556a8656756591b7e/packages/typescript-worker/src/parts/CreateModuleResolver/CreateModuleResolver.ts) strips `file://` before calling TypeScript, then restores it on a successful result. That explains part of the mixture of raw paths and URI keys seen in the earlier investigation. Other schemes take a different route.

URI-shaped names work for ordinary relative imports and package lookup, including package `exports` in the NodeNext ESM probe. They do not automatically give the resolver URL decoding semantics. With a canonical URI host entry `memfs:///workspace/src/space%20name.ts`, importing `./space name.js` fails, while `./space%20name.js` succeeds. The same distinction appears with hashes and literal percent signs. This is a mismatch between encoded resource identity and lexical compiler filenames, rather than a failure to recognize the scheme.

Absolute URI import specifiers are another question: the standard resolver does not resolve the absolute resource URI in these fixtures, even though it accepts that URI as a containing filename. Such imports need an explicit resolver/runtime policy. The probes concern compiler lookup, not a guarantee about JavaScript runtime URL import semantics.

## Prototype and correctness probes

[`CompilerPathMap`](../src/compiler-path-map.ts) assigns each provider root an opaque compiler mount, for example:

```text
memfs://project/workspace/space%20name.ts
    ↔ //lvce-mount-0/workspace/space name.ts
html://preview/workspace/main.ts
    ↔ //lvce-mount-1/workspace/main.ts
```

The URI remains the resource identity outside the compiler. The decoded compiler path is private to the adapter. Mounts distinguish schemes, authorities (including remote user information) and local Windows volumes. TypeScript treats the UNC-shaped prefix as a root, so ancestor lookup stops within the mount. A simple `/file/<path>` or `/html/<path>` convention needs additional rules to preserve authorities and volumes, and ordinary POSIX ancestor lookup can climb out to the global `/node_modules` namespace.

The experiment asserts resolver behavior for six resource roots and ten import spellings in both representations: 120 cases. The mapped host resolves literal spaces, hashes and percent signs using ordinary path-based specifiers. Encoded specifiers then follow compiler path semantics; changing representation does not transparently preserve every import spelling. Separate unit tests cover provider separation, Windows drives, UNC authorities, Unicode, percent versus escaped-percent identity, and explicit rejection of unsupported query/fragment or separator cases.

This is an investigation prototype, not a production URI canonicalizer. It uses WHATWG URL parsing and project-lifetime maps; provider canonicalization and case rules must be chosen explicitly. Query and fragment identities, encoded separators, encoded drive aliases, symlinks, file-host aliases and unusual provider names need an agreed policy. The prototype rejects queries/fragments and decoded separators rather than silently discarding identity.

## Controlled about-view experiment

The [workflow](../.github/workflows/typescript-paths.yml) checks out the compiler dependency at `c7434ae2cc7d89f5e178f84556a8656756591b7e` and about-view at `db84fa6c54201e7ebb026be3d7aab3436785e9f5`. Node 24.15.0 and TypeScript 6.0.3 run four standard language-service hosts:

- `native`: ordinary disk paths and direct Node filesystem access.
- `uri`: file URI compiler filenames, converting incoming filesystem callbacks each time.
- `uri-cached`: the same URI filenames, memoizing URI-to-disk conversion.
- `mapped`: private provider-mounted compiler paths, memoizing compiler-to-URI-to-disk conversion.

Each mode runs in seven fresh Node processes, rotating/reversing order. The timer includes configuration and program creation plus semantic diagnostics for the opened aboutWorkerMain.ts file. It excludes loading the compiler/harness and final source hashing. Forward filename creation is cached in all non-native variants. Conversion counters/timers specifically measure incoming host path conversion; initial forward-name registration and cache hits are not included in that conversion timer, though work during program creation is included in total duration.

The runner requires identical sorted physical filenames and source content hashes, and no diagnostics for the opened file. This is direct Node I/O with the standard TypeScript resolver, without LVCE's custom resolver, browser or IPC. It establishes compatibility for this project, not every language feature or provider. Filesystem caches are not flushed; fresh processes do not mean cold disk caches. Small timing differences need further repetitions and runners.

[CI run 37317911482](https://github.com/lvce-editor/performance-investigations/actions/runs/37317911482), seven repetitions per mode, all graphs equal: 145 roots and 732 loaded files, no opened-file diagnostics. [Saved overview and repetitions](typescript-path-identities-overview.json), [compact resolver results](typescript-uri-resolution.json).

| Compiler filenames | Median total | Range | Incoming conversion time | Conversions / cache hits |
|---|---:|---:|---:|---:|
| Native paths | 979.5 ms | 960.8–998.9 ms | 0 ms | 0 / 0 |
| File URIs | 1,034.8 ms | 1,012.5–1,055.7 ms | 14.7 ms | 3,565 / 0 |
| File URIs, cached conversions | 1,058.8 ms | 1,038.2–1,095.1 ms | 12.4 ms | 2,805 / 760 |
| Mounted paths, cached conversions | 1,066.4 ms | 1,048.4–1,085.5 ms | 35.9 ms | 2,805 / 760 |

Native paths were fastest on this runner. URI filenames added about 55 ms (5.6%) to the median total. Memoizing conversions reduced measured conversion time slightly but did not improve the total in this run. The mapped prototype was about 87 ms (8.9%) slower than native and 32 ms slower than plain URI filenames; it is not evidence of a performance optimization. Its misses encode a compiler path back to a URI and then decode it for Node filesystem access, which is avoidable for a specialized native-file backend.

All modes made exactly 774 reads, 679 directory-existence calls, 2,066 file-existence calls, 45 realpath calls and one directory enumeration. There were 3,555 distinct method/path requests. These are standard-host counts and differ from the earlier LVCE custom-resolver counts; do not compare them as an improvement across implementations. The 760 conversion cache hits save conversions only, not filesystem calls.

The conversion measurements are tens of milliseconds, approximately 1–3.4% of total duration. Longer filenames and TypeScript's own path/cache operations contribute work beyond the instrumented conversion timer. They are still far below the earlier browser's seconds of synchronous filesystem IPC. A native backend could map compiler paths directly to disk paths, while URI providers encode on cache miss at the provider boundary. Benchmark that implementation before attributing a speed advantage to mapping.

Run locally after installing both pinned checkouts:

```sh
node src/typescript-path-experiment.ts /path/to/compiler-checkout /path/to/about-view results/path-identities 7
```

## Recommendation and implementation boundary

Prefer resource URIs throughout LVCE, with a private compiler filename layer where needed. Keep that layer centralized and memoized. Register mounts independently of user-controlled paths and preserve provider identity; use consistent compiler names for roots, snapshots, resolver results and caches. Avoid repeatedly bouncing between URI and native path spellings inside the worker.

A migration must translate the full boundary: current directory, configuration and path-valued options (`baseUrl`, `paths`, `typeRoots`, project references), default libraries, all host callbacks, module resolution, and returned diagnostics/navigation/rename/completion locations. Synthetic paths must never escape into editor documents, filesystem IPC or displayed import suggestions. Runtime-aware URI specifiers need separate handling. Cache invalidation must follow document/project/provider lifecycle; request caches and persistent conversion caches have different lifetimes.

Do not make a production-wide path migration solely for speed based on this experiment. The [previous browser comparison](typescript-cli.md) found 1.62–2.98 seconds in synchronous filesystem RPC on its two runners, mainly metadata probes. The useful performance target remains fewer round trips and consistent cache identities. A path mapping can enable that consistency, but does not itself reduce the number of standard TypeScript filesystem queries. Validate a production adapter change with the real browser IPC benchmark, edits/invalidation, remote and virtual providers, and language-feature tests before claiming startup improvement.
