import { spawnSync, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { availableParallelism, cpus } from 'node:os'

const [extensionArg, workspaceArg, nativeArg, outputArg, repeatsArg = '5'] = process.argv.slice(2)
if (!outputArg) throw new Error('Usage: typescript-seven-experiment.ts <extension> <workspace> <ts7-package> <output> [repeats]')
const extension = resolve(extensionArg), workspace = resolve(workspaceArg), native = resolve(nativeArg), output = resolve(outputArg)
const repeats = Number(repeatsArg)
if (!Number.isInteger(repeats) || repeats < 3 || repeats > 10) throw new Error('Use 3 to 10 repetitions')
mkdirSync(output, { recursive: true })
const scripts = dirname(fileURLToPath(import.meta.url))
const ts6 = join(extension, 'node_modules/typescript'), tsc6 = join(ts6, 'lib/tsc.js'), tsc7 = join(native, 'bin/tsc')
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const run = (name: string, args: string[]) => {
  const before = performance.now()
  const child = spawnSync(process.execPath, args, { cwd: workspace, encoding: 'utf8', timeout: 480_000, maxBuffer: 30 * 1024 * 1024 })
  const processElapsedMs = performance.now() - before
  writeFileSync(join(output, name + '.log'), child.stdout + child.stderr)
  if (child.error || child.signal || child.status !== 0) throw new Error(`${name}: ${child.error ?? child.signal ?? child.stdout + child.stderr}`)
  return { processElapsedMs, stdout: child.stdout }
}
const modes = ['cli6', 'cli7', 'cli7-single-threaded', 'ts6', 'ts7', 'lvce']
const rows: any[] = []
for (let iteration = 0; iteration < repeats; iteration++) {
  const order = iteration % 2 ? modes.toReversed() : modes
  for (const mode of order) {
    const name = `${mode}-${iteration}`, destination = join(output, name + '.json')
    if (mode.startsWith('cli')) {
      const result = run(name, [mode === 'cli6' ? tsc6 : tsc7, '-p', 'packages/about-view/tsconfig.json', '--noEmit', '--extendedDiagnostics',
        '--tsBuildInfoFile', join(output, name + '-fresh.tsbuildinfo'), ...(mode === 'cli7-single-threaded' ? ['--singleThreaded'] : [])])
      const extendedDiagnostics = Object.fromEntries([...result.stdout.matchAll(/^([^:\n]+):\s+([^\n]+)$/gm)].map(match => [match[1].trim(), match[2].trim()]))
      rows.push({ mode, iteration, processElapsedMs: result.processElapsedMs, extendedDiagnostics })
    } else if (mode === 'lvce') {
      const directory = join(output, name); mkdirSync(directory)
      const result = run(name, [join(scripts, 'typescript-seven-browser.ts'), extension, workspace, directory, '1'])
      const benchmark = JSON.parse(readFileSync(join(directory, 'browser-overview.json'), 'utf8'))
      rows.push({ mode, ...benchmark.rows[0], iteration, harnessProcessElapsedMs: result.processElapsedMs })
    } else {
      const result = run(name, [join(scripts, 'typescript-seven-service.ts'), mode, mode === 'ts6' ? ts6 : native, workspace, destination])
      rows.push({ mode, iteration, processElapsedMs: result.processElapsedMs, ...JSON.parse(readFileSync(destination, 'utf8')) })
    }
    console.log(JSON.stringify({ mode, iteration, coldMs: rows.at(-1).samples?.[0].durationMs, cliMs: rows.at(-1).processElapsedMs }))
  }
}
// Capture compiler graphs outside the timing samples. Native libraries are embedded and
// differ between compiler versions; assert equality of all non-library source paths.
const normalize = (path: string) => {
  if (path.startsWith('file:')) path = fileURLToPath(path)
  return path.startsWith(workspace + '/') ? relative(workspace, path) : path
}
const graphs = Object.fromEntries(['cli6', 'cli7'].map(mode => {
  const { stdout } = run(mode + '-files', [mode === 'cli6' ? tsc6 : tsc7, '-p', 'packages/about-view/tsconfig.json', '--listFilesOnly'])
  return [mode, stdout.trim().split('\n').map(line => normalize(line.trim())).sort()]
}))
const projectFiles = (files: string[]) => files.filter(path => !/(^|\/)lib\.[^/]+\.d\.ts$/.test(path))
const ts6Graph = rows.find(row => row.mode === 'ts6').metadata.loadedFiles.map(normalize).sort()
const browserGraph = rows.find(row => row.mode === 'lvce').samples[0].trace.loadedFiles.map((item: any) => normalize(item.fileName)).sort()
for (const row of rows.filter(row => ['ts6', 'lvce'].includes(row.mode))) {
  const files = row.mode === 'ts6' ? row.metadata.loadedFiles : row.samples[0].trace.loadedFiles.map((item: any) => item.fileName)
  if (JSON.stringify(projectFiles(files.map(normalize).sort())) !== JSON.stringify(projectFiles(graphs.cli6))) throw new Error(`Service source graph differs: ${row.mode}/${row.iteration}`)
}
if (JSON.stringify(projectFiles(graphs.cli6)) !== JSON.stringify(projectFiles(graphs.cli7))) throw new Error('CLI non-library source graphs differ')
if (JSON.stringify(projectFiles(graphs.cli6)) !== JSON.stringify(projectFiles(ts6Graph))) throw new Error('TS6 service non-library source graph differs')
if (JSON.stringify(projectFiles(graphs.cli6)) !== JSON.stringify(projectFiles(browserGraph))) throw new Error('Browser non-library source graph differs')
const median = (values: number[]) => { const sorted = values.toSorted((a, b) => a - b), middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 }
const perTrial = (row: any, kind: string) => median(row.samples.filter((sample: any) => sample.kind === kind).map((sample: any) => sample.durationMs))
const requestKinds = ['cold', 'unchanged', 'edit', 'restore', 'completion-first', 'completion', 'references-first', 'references']
const featureResults = (row: any, kind: string) => row.samples.find((sample: any) => sample.kind === kind).result
const referenceIdentity = (items: any[]) => items.map(item => ({ ...item, uri: normalize(item.uri) })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
for (const row of rows.filter(row => ['ts6', 'ts7', 'lvce'].includes(row.mode))) {
  const baseline = rows.find(other => other.mode === 'ts6' && other.iteration === row.iteration)
  if (JSON.stringify(referenceIdentity(featureResults(row, 'references-first'))) !== JSON.stringify(referenceIdentity(featureResults(baseline, 'references-first')))) throw new Error(`Reference results differ: ${row.mode}`)
  if (JSON.stringify(featureResults(row, 'completion-first')) !== JSON.stringify(featureResults(baseline, 'completion-first'))) throw new Error(`Completion labels differ: ${row.mode}`)
}
const summary = Object.fromEntries(modes.map(mode => {
  const trials = rows.filter(row => row.mode === mode)
  return [mode, mode.startsWith('cli') ? { processElapsedMs: median(trials.map(row => row.processElapsedMs)), extendedDiagnostics: trials.map(row => row.extendedDiagnostics) }
    : Object.fromEntries(requestKinds.map(kind => [kind + 'Ms', median(trials.map(row => perTrial(row, kind)))]))]
}))
const pairedRatios = Object.fromEntries(requestKinds.map(kind => [kind, median(Array.from({ length: repeats }, (_, iteration) =>
  perTrial(rows.find(row => row.mode === 'lvce' && row.iteration === iteration), kind) / perTrial(rows.find(row => row.mode === 'ts7' && row.iteration === iteration), kind)))]))
const overview = {
  schemaVersion: 1, node: process.version, platform: process.platform, architecture: process.arch, logicalCpus: availableParallelism(), cpuModel: cpus()[0].model, repeats,
  extensionCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: extension, encoding: 'utf8' }).trim(),
  workspaceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim(),
  compiler6: JSON.parse(readFileSync(join(ts6, 'package.json'), 'utf8')).version,
  compiler7: JSON.parse(readFileSync(join(native, 'package.json'), 'utf8')).version,
  lockHashes: { extension: hash(join(extension, 'package-lock.json')), workspace: hash(join(workspace, 'package-lock.json')), native: hash(join(native, '../../package-lock.json')) },
  sourceFiles: projectFiles(graphs.cli6).map(path => ({ path, sha256: hash(join(workspace, path)) })),
  graphs, summary, pairedExtensionOverNativeRatios: pairedRatios, rows,
  notes: [
    'Each repetition alternates variant order; fresh processes and browser state, OS filesystem caches retained. No timed request is CPU-profiled.',
    'CLI timings include Node wrapper and native child startup and whole-project checking. CLI incremental state is fresh for every run.',
    'TS6 service cold includes config/program construction after loading the compiler. TS7 cold covers didOpen through the complete pull-diagnostic response after LSP initialize.',
    'LVCE timings cover harness-only commands forwarding to existing worker entry points, including activation on cold. Worker-only diagnostic traces are also saved. Browser/server startup and rendering are excluded.',
    'Five unchanged requests and five edit/restore pairs per trial. Edits add a type error to the open document in memory; the original file is never changed. Every edit must report the error; every restore must clear it.',
    'TS6 service uses semantic diagnostics; TS7 pull diagnostics can also include syntactic diagnostics. CLI checks the whole configured project. These boundaries are explicitly distinct.',
    'Completion and reference requests follow diagnostics and restore; first requests and four repeats are recorded separately. Completion labels and reference locations must match across all three services.',
    'CLI and TS6/browser service non-library file paths must match; TS7 LSP must select the same tsconfig. No claim of identical TS7 LSP internal source graphs is made.',
  ],
}
writeFileSync(join(output, 'overview.json'), JSON.stringify(overview, null, 2) + '\n')
console.log(JSON.stringify({ summary, pairedExtensionOverNativeRatios: pairedRatios }, null, 2))
