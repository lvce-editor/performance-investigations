import { spawnSync, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { analyze } from './analyze.ts'

const [checkoutArg, workspaceArg, outputArg, repeatsArg = '5'] = process.argv.slice(2)
if (!outputArg) throw new Error('Usage: typescript-cli-experiment.ts <extension> <workspace> <output-dir> [repeats]')
const checkout = resolve(checkoutArg), workspace = resolve(workspaceArg), output = resolve(outputArg)
const repeats = Number(repeatsArg)
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error('Repeats must be 1 to 20')
mkdirSync(output, { recursive: true })
const require = createRequire(join(checkout, 'package.json'))
const workspaceRequire = createRequire(join(workspace, 'package.json'))
const ts = require('typescript')
if (ts.version !== workspaceRequire('typescript').version) throw new Error('Workspace and extension TypeScript versions differ')
const script = join(dirname(fileURLToPath(import.meta.url)), 'typescript-host-benchmark.ts')
const tsc = workspaceRequire.resolve('typescript/lib/tsc.js')
const results: any[] = []
const run = (mode: string, iteration: number, profiled: boolean) => {
  const prefix = join(output, `${mode}-${profiled ? 'profile' : iteration}`)
  const profile = `${prefix}.cpuprofile`
  // Unique state files prevent composite/incremental reuse, including across invocations.
  const buildInfo = `${prefix}-${process.pid}-${Date.now()}.tsbuildinfo`
  if (existsSync(buildInfo)) throw new Error('Build state already exists')
  const args = mode === 'tsc'
    ? [...(profiled ? ['--cpu-prof', `--cpu-prof-dir=${output}`, `--cpu-prof-name=${mode}-profile.cpuprofile`] : []), tsc, '--project', 'packages/about-view/tsconfig.json', '--noEmit', '--extendedDiagnostics', '--tsBuildInfoFile', buildInfo]
    : [script, mode, checkout, workspace, `${prefix}.json`, ...(profiled ? [profile] : [])]
  const start = performance.now()
  const child = spawnSync(process.execPath, args, { cwd: workspace, encoding: 'utf8', timeout: 120_000, maxBuffer: 20 * 1024 * 1024 })
  const processElapsedMs = performance.now() - start
  writeFileSync(`${prefix}.log`, child.stdout + child.stderr)
  if (child.error || child.signal || child.status !== 0) throw new Error(`${mode} failed: ${child.error ?? child.signal ?? child.stdout + child.stderr}`)
  const summary = mode === 'tsc' ? { extendedDiagnostics: Object.fromEntries([...child.stdout.matchAll(/^([^:\n]+):\s+([^\n]+)$/gm)].map(match => [match[1].trim(), match[2].trim()])), diagnostics: [] } : JSON.parse(readFileSync(`${prefix}.json`, 'utf8'))
  if (summary.diagnostics.length) throw new Error(`${mode}: unexpected diagnostics`)
  if (mode === 'tsc') writeFileSync(`${prefix}.json`, JSON.stringify(summary, null, 2) + '\n')
  const row = { mode, iteration, profiled, processElapsedMs, ...summary }
  results.push(row)
  console.log(JSON.stringify({ mode, iteration, profiled, processElapsedMs, durationMs: row.durationMs, extendedDiagnostics: row.extendedDiagnostics }))
}
// Alternate order; every invocation is a fresh process, with OS filesystem caches left intact.
for (let iteration = 0; iteration < repeats; iteration++) {
  for (const mode of iteration % 2 ? ['lvce', 'native', 'tsc'] : ['tsc', 'native', 'lvce']) run(mode, iteration, false)
}
for (const mode of ['tsc', 'native', 'lvce']) {
  run(mode, 0, true)
  writeFileSync(join(output, `${mode}-profile-summary.json`), JSON.stringify(await analyze(join(output, `${mode}-profile.cpuprofile`)), null, 2) + '\n')
}
const median = (values: number[]) => {
  const sorted = values.toSorted((a,b) => a-b), mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid-1] + sorted[mid]) / 2
}
const modes = Object.fromEntries(['tsc', 'native', 'lvce'].map(mode => {
  const rows = results.filter(row => row.mode === mode && !row.profiled)
  return [mode, {
    processElapsedMs: median(rows.map(row => row.processElapsedMs)),
    diagnosticRequestMs: mode === 'tsc' ? null : median(rows.map(row => row.durationMs)),
    compilerMeasures: mode === 'tsc' ? null : Object.fromEntries(Object.keys(rows[0].compilerMeasures).map(name => [name, median(rows.map(row => row.compilerMeasures[name]))])),
    methods: mode === 'tsc' ? null : Object.fromEntries(Object.keys(rows[0].methods).map(name => [name, {
      calls: median(rows.map(row => row.methods[name].calls)),
      durationMs: median(rows.map(row => row.methods[name].durationMs)),
      bytes: median(rows.map(row => row.methods[name].bytes)),
    }])), rootFiles: rows[0].rootFiles?.length, loadedFiles: rows[0].loadedFiles?.length,
    extendedDiagnostics: mode !== 'tsc' ? null : Object.fromEntries(Object.keys(rows[0].extendedDiagnostics).map(name => {
      const value = rows[0].extendedDiagnostics[name], unit = value.replace(/^[\d.]+/, '')
      return [name, `${median(rows.map(row => Number.parseFloat(row.extendedDiagnostics[name])))}${unit}`]
    })),
  }]
}))
const native = results.find(row => row.mode === 'native'), lvce = results.find(row => row.mode === 'lvce')
const comparison = {
  rootsEqual: JSON.stringify(native.rootFiles) === JSON.stringify(lvce.rootFiles),
  loadedFilesEqual: JSON.stringify(native.loadedFiles) === JSON.stringify(lvce.loadedFiles),
  onlyNative: native.loadedFiles.filter((file: any) => !lvce.loadedFiles.some((other: any) => other.path === file.path)),
  onlyLvce: lvce.loadedFiles.filter((file: any) => !native.loadedFiles.some((other: any) => other.path === file.path)),
}
if (!comparison.rootsEqual || !comparison.loadedFilesEqual) throw new Error(`Host source graphs differ: ${JSON.stringify(comparison)}`)
writeFileSync(join(output, 'overview.json'), JSON.stringify({
  schemaVersion: 1, nodeVersion: process.version, typescriptVersion: ts.version, repeats,
  extensionCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim(),
  workspaceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim(),
  comparison, modes, results,
  note: 'Unprofiled medians; profiling is a separate run. tsc checks all project files and declarations; hosts request semantic diagnostics for one file. Process elapsed includes Node/module startup; diagnosticRequestMs excludes it. Fresh language services and incremental state, warm OS filesystem caches, no browser IPC in host runs. Compiler measures overlap.',
}, null, 2) + '\n')
