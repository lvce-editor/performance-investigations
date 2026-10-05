import { spawnSync, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { probeUris } from './typescript-uri-probes.ts'

const [checkoutArg, workspaceArg, outputArg, repeatsArg = '7'] = process.argv.slice(2)
if (!outputArg) throw new Error('Usage: typescript-path-experiment.ts <TS checkout> <about-view> <output-dir> [repeats]')
const checkout = resolve(checkoutArg), workspace = resolve(workspaceArg), output = resolve(outputArg)
const repeats = Number(repeatsArg)
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error('Repeats must be 1 to 20')
mkdirSync(output, { recursive: true })
const require = createRequire(join(checkout, 'package.json')), ts = require('typescript')
const modes = ['native', 'uri', 'uri-cached', 'mapped'], results: any[] = []
const script = join(dirname(fileURLToPath(import.meta.url)), 'typescript-path-host.ts')
for (let iteration = 0; iteration < repeats; iteration++) {
  // Rotate the first variant and reverse alternate rounds, avoiding a fixed order.
  const offset = iteration % modes.length
  let order = [...modes.slice(offset), ...modes.slice(0, offset)]
  if (iteration % 2) order = order.reverse()
  for (const mode of order) {
    const outputFile = join(output, `${mode}-${iteration}.json`)
    const child = spawnSync(process.execPath, [script, mode, checkout, workspace, outputFile], { encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 * 1024 })
    writeFileSync(join(output, `${mode}-${iteration}.log`), child.stdout + child.stderr)
    if (child.error || child.signal || child.status !== 0) throw new Error(`${mode} failed: ${child.error ?? child.signal ?? child.stderr}`)
    const result = JSON.parse(readFileSync(outputFile, 'utf8'))
    if (result.diagnostics.length) throw new Error(`${mode} produced diagnostics: ${JSON.stringify(result.diagnostics)}`)
    if (results.length && result.graphHash !== results[0].graphHash) throw new Error(`${mode} loaded a different source graph`)
    results.push({ iteration, ...result })
    console.log({ iteration, mode, durationMs: result.durationMs, conversionMs: result.conversionMs })
  }
}
const median = (values: number[]) => {
  const sorted = values.toSorted((a,b) => a-b), mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid-1] + sorted[mid]) / 2
}
const summary = Object.fromEntries(modes.map(mode => {
  const rows = results.filter(row => row.mode === mode)
  return [mode, Object.fromEntries(['durationMs', 'conversions', 'conversionMs', 'conversionCacheHits', 'uniqueRequests'].map(field => [field, median(rows.map(row => row[field]))]))]
}))
const probes = probeUris(ts)
writeFileSync(join(output, 'uri-probes.json'), JSON.stringify(probes, null, 2) + '\n')
writeFileSync(join(output, 'overview.json'), JSON.stringify({ schemaVersion: 1, compilerCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim(), workspaceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim(), nodeVersion: process.version, typescriptVersion: ts.version, repeats, graphHash: results[0].graphHash, loadedFiles: results[0].graph.length, rootFiles: results[0].rootCount, allGraphsEqual: true, modes: summary, repetitions: results.map(({graph,...row}) => row), note: 'Fresh Node processes in rotated order, no profiler or IPC. Same standard TypeScript host and resolver; all successful source graphs and empty diagnostics must match. URI host forwards encoded URI strings; mapped host uses mount-specific UNC compiler roots and caches conversions. Includes config and program creation, excludes compiler/harness imports.' }, null, 2) + '\n')
console.log(summary)
