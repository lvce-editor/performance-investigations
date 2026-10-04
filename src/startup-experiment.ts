import { spawn } from 'node:child_process'
import { mkdir, writeFile, readFile, appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const repeats = Number(process.env.REPEATS ?? '3')
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 5) throw new Error('REPEATS must be 1 to 5')
await mkdir('results', { recursive: true })
const runs: any[] = []
for (let iteration = 0; iteration < repeats; iteration++) {
  for (const variant of iteration % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
    const output = resolve(`results/${variant}-${iteration}`)
    const executable = resolve(`runtimes/${variant}/root/usr/lib/lvce/resources/app/bin/lvce`)
    const args = ['--max-old-space-size=4096', 'src/capture.ts', executable, resolve('benchmark-workspace'), 'packages/about-view/src/aboutWorkerMain.ts', output]
    await new Promise<void>((done, reject) => {
      const child = spawn(process.execPath, args, { stdio: 'inherit' })
      child.once('error', reject)
      child.once('exit', (code) => code === 0 ? done() : reject(new Error(`Capture exited ${code}`)))
    })
    const capture = JSON.parse(await readFile(`${output}/capture.json`, 'utf8'))
    const summary = JSON.parse(await readFile(`${output}/summary.json`, 'utf8'))
    runs.push({ variant, iteration, tag: process.env[variant.toUpperCase()], elapsedMs: capture.elapsedMs, traceDurationMs: summary.traceDurationMs, profiles: summary.profiles.map((p: any) => ({ role: p.role, nonIdleMs: p.nonIdleMs, earlyNonIdleMs: p.earlyNonIdleMs })) })
    await writeFile('results/overview.json', JSON.stringify(runs, null, 2) + '\n')
  }
}
const median = (values: number[]) => { values.sort((a, b) => a - b); const m = Math.floor(values.length / 2); return values.length % 2 ? values[m] : (values[m - 1] + values[m]) / 2 }
let markdown = '### Profile capture duration\n\nIncludes profiler startup, diagnostics, trace serialization and shutdown; not time to first paint.\n\n| Variant | Release | Median trace duration (ms) | Runs |\n| --- | --- | ---: | ---: |\n'
for (const variant of ['baseline', 'candidate']) {
  const selected = runs.filter((r) => r.variant === variant)
  markdown += `| ${variant} | ${selected[0].tag} | ${median(selected.map((r) => r.traceDurationMs)).toFixed(1)} | ${selected.length} |\n`
}
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown)
console.log(markdown)
