# Rollup for Electron internal JavaScript

The complete Electron `node_init` entry bundles with Rollup without a Chromium/Electron build. A disposable source probe can execute inside the downloaded LVCE executable, but only after changing V8 compilation flags. The real Rollup bundle does not fit the original embedded source slot. We therefore have **no runnable replacement application and no demonstrated startup or memory improvement**. This is a feasibility result, not a production bundler migration.

## Pinned inputs

The official [LVCE v0.120.23 Linux x64 Debian package](https://github.com/lvce-editor/lvce-editor/releases/tag/v0.120.23) was downloaded and extracted without installing it. Its release digest matches SHA-256 `4a7dbd0fc21fc4bd5bd6e168fba8751e08cb01f0574f0d102aa6ab05400a6942`. Both the packaged `version` file and `ELECTRON_RUN_AS_NODE=1 lvce -p 'process.versions.electron'` identify Electron `44.4.5`. The matching upstream tag resolves to `694f45852a0f1726cd23bfd379854de489cccb65`. Source, executable, snapshot, bundle hashes, exact tool versions and raw probe results are in [electron-rollup-results.json](electron-rollup-results.json); tools are locked by the repository lockfile. Electron upstream was used read-only.

## Where the code lives

In the [matching BUILD.gn](https://github.com/electron/electron/blob/694f45852a0f1726cd23bfd379854de489cccb65/BUILD.gn#L210), eight webpack targets produce browser, renderer, worker, sandbox, isolated, node, utility and preload-realm bundles. `electron_js2c` feeds those files to Node's js2c tool through [build/js2c.py](https://github.com/electron/electron/blob/694f45852a0f1726cd23bfd379854de489cccb65/build/js2c.py), generating compiled C++ data. These are not LVCE application modules in `resources`, nor replaceable JS files beside the executable.

[NodeBindings::LoadEnvironment](https://github.com/electron/electron/blob/694f45852a0f1726cd23bfd379854de489cccb65/shell/common/node_bindings.cc#L999) and [CompileBundle](https://github.com/electron/electron/blob/694f45852a0f1726cd23bfd379854de489cccb65/shell/common/node_util.cc#L29) use native BuiltinLoader and refresh embedded build-time code caches. The [native wrapper contracts](https://github.com/electron/electron/blob/694f45852a0f1726cd23bfd379854de489cccb65/shell/common/js2c_bundle_ids.h) include `process, require` for node/browser init, `binding` for sandbox/preload, and `isolatedApi` for the isolated renderer. The source patch [adding code-cache consumption](https://github.com/electron/electron/blob/694f45852a0f1726cd23bfd379854de489cccb65/patches/node/electron_build-time_v8_code_cache_for_the_electron_js2c_bundles.patch) explicitly describes framework bundles as not snapshotted; the external `snapshot_blob.bin` is not an editable bundle container. Replacing application assets or evaluating a bundle after bootstrap would not demonstrate replacement of these native entry points.

## Experiments

`src/electron-source-probe.ts` extracts `electron/js2c/node_init` via `process.binding('natives')`, finds its unique ASCII byte range at offset 20,567,984, and writes a temporary sibling executable with a marker in that exact range, padding to the unchanged 20,772-byte length. The original package is never edited. The probe is deliberately incomplete and cannot be used as an application candidate.

| Flags on disposable probe | Application entry executes | Replacement marker executes |
| --- | --- | --- |
| normal | yes | no |
| `--no-lazy` | yes | yes |

The normal run executing the original cached code despite changed source is consistent with native code-cache loading. The second row establishes actual internal-source execution, rather than merely observing changed bytes. It does not establish equivalent semantics or performance: changing V8 flags also changes compilation and cache behavior across the runtime. Same-size source patching alone is insufficient.

`src/electron-rollup.ts` builds the **whole** `lib/node/init.ts` and its ASAR filesystem wrapper from the matching clean source tree. TypeScript emits CommonJS; Rollup's CommonJS plugin retains strict lazy require wrappers to preserve side-effect ordering. Tree shaking is disabled. Node builtins and `internal/*` imports remain native externals; `__non_webpack_require__` becomes native `require`. Function/class names are retained during minification. The generated entry is wrapped for the native `process, require` function contract and receives an execution marker. No internal modules are discarded or replaced by stubs.

| Bundle | Bytes |
| --- | ---: |
| original embedded webpack node_init | 20,772 |
| Rollup node_init including native scope and marker | 21,095 |
| increase | 323 (1.55%) |

The candidate parses with the native function parameters but exceeds the fixed source slot, so the script records `blocked-oversized-source` and produces no patched candidate executable. A diagnostic build hoisting CommonJS wrappers reduced size to 20,817 bytes, still over capacity; it was discarded because preserving ordering is preferable to an unvalidated semantic change. This size comparison is specific to this conservative configuration and entry, not a general verdict on Rollup. Padding would eliminate file-size savings even for a smaller bundle.

## Feasibility boundary and next experiment

There is no supported external bundle override in the inspected loading path. The bounded binary-patching route requires a fitting source and demonstrated cache rejection; this candidate does not meet both conditions. An arbitrary larger bundle would need native-data relocation/length changes and compatible cache handling, or a custom Electron native build/relink. We did neither. This does **not** prove every conceivable injection technique impossible, but it explains why this experiment cannot supply a faithful replacement under the no-full-build constraint.

`node_init` initializes run-as-Node subprocesses (ASAR support and child-process behavior). It does not replace the main `browser_init` startup entry. An editor window opening with this byte range changed would not by itself prove the Rollup bundle ran. No launch/window/preload/IPC/editor acceptance pass is claimed for the oversized bundle. Those checks must follow execution-marker validation on a real complete candidate.

A next bounded experiment could reduce wrapper overhead while proving ASAR read/write/stat and child fork/IPC semantics, then invalidate only the affected cache with explicit provenance. A main-startup experiment additionally needs a fitting `browser_init` candidate and evidence that its code executes. Even a valid node-only candidate would support conclusions about subprocess bootstrap, not process-entry-to-editor-paint latency.

No timing series is reported because there is no valid candidate to alternate against the baseline. Future measurements must hold application/workspace/flags constant, alternate repeated baseline/candidate runs, measure unprofiled process-entry/app-ready/editor-paint milestones, retain failures and memory data, and report uncertainty. Fresh isolated XDG/Chromium profiles and reused profiles should be separate cold/warm application-state cases; OS page-cache conditions must be stated (and must not be called cold merely because the profile is fresh). A `--no-lazy` comparison could measure an artificial uncached configuration but would not establish a normal released-runtime improvement.

## Reproduce

From this repository, use Node 24 and Linux x64:

```sh
npm ci
mkdir -p .tmp/electron-rollup
curl -fL https://github.com/lvce-editor/lvce-editor/releases/download/v0.120.23/lvce-v0.120.23_amd64.deb -o .tmp/electron-rollup/lvce.deb
echo '4a7dbd0fc21fc4bd5bd6e168fba8751e08cb01f0574f0d102aa6ab05400a6942  .tmp/electron-rollup/lvce.deb' | sha256sum -c -
dpkg-deb -x .tmp/electron-rollup/lvce.deb .tmp/electron-rollup/app
git clone --depth 1 --branch v44.4.5 https://github.com/electron/electron.git .tmp/electron-rollup/source
node src/electron-rollup.ts .tmp/electron-rollup/source .tmp/electron-rollup/app/usr/lib/lvce/lvce .tmp/electron-rollup/build
node src/electron-source-probe.ts .tmp/electron-rollup/app/usr/lib/lvce/lvce .tmp/electron-rollup/source-probe.json
node -e 'const fs=require("fs"); new Function("process","require",fs.readFileSync(".tmp/electron-rollup/build/node-init-rollup.js","utf8"))'
```

The dedicated Linux feasibility workflow reproduces the bundle, native syntax validation and two cache probes, uploading generated bundles/provenance. The ordinary Checks workflow retains the repository's test gate. No full native build, desktop launch, user-profile change, production release or performance-budget adjustment is required for this report.
