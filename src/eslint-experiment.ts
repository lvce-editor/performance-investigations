import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { analyze } from './analyze.ts'
const repeats = Number(process.env.REPEATS ?? '3')
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 5) throw new Error('REPEATS must be 1 to 5')
const root = process.cwd()
const run = (args: string[], cwd = root) => new Promise<void>((done, reject) => {
  const child = spawn(process.execPath, args, { cwd, stdio: 'inherit' })
  child.once('error', reject)
  child.once('exit', (code) => code === 0 ? done() : reject(new Error(`Experiment exited ${code}`)))
})
const runs: any[] = []
await mkdir('results', { recursive: true })
for (let iteration = 0; iteration < repeats; iteration++) {
  for (const variant of iteration % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
    const checkout = resolve(`experiments/${variant}`)
    const workspace = resolve('benchmark-workspace')
    const output = resolve(`results/${variant}-${iteration}`)
    await mkdir(output)
    await run(['--expose-gc', 'src/graph-benchmark.ts', checkout, workspace, join(output, 'graph.json')])
    for (const mode of ['cold', 'reload']) {
      const browserOutput = join(output, mode)
      await run(['packages/benchmark/src/main.ts', '--repo', workspace, '--file', 'packages/about-view/src/aboutWorkerMain.ts', '--output', browserOutput, '--timeout', '180000', ...(mode === 'reload' ? ['--reload'] : [])], checkout)
      const summary = await analyze(join(browserOutput, 'cpu-profile.json'))
      await writeFile(join(browserOutput, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
      const benchmark = JSON.parse(await readFile(join(browserOutput, 'benchmark.json'), 'utf8'))
      runs.push({ variant, iteration, mode, ref: process.env[variant.toUpperCase()], durationMs: benchmark.durationMs, lintDurationMs: benchmark.lintDurationMs, warmupDurationMs: benchmark.warmupDurationMs, profiles: summary.profiles.map((p: any) => ({ role: p.role, nonIdleMs: p.nonIdleMs })) })
      await writeFile('results/overview.json', JSON.stringify(runs, null, 2) + '\n')
    }
  }
}
const median = (values: number[]) => { values.sort((a, b) => a - b); const m = Math.floor(values.length / 2); return values.length % 2 ? values[m] : (values[m - 1] + values[m]) / 2 }
let markdown = '### ESLint benchmark\n\nSame pinned workspace and machine; alternating variant order. Cold means fresh browser context, with warm OS file caches. The harness waits for its test overlay, not first paint.\n\n| Mode | Baseline median (ms) | Candidate median (ms) | Change |\n| --- | ---: | ---: | ---: |\n'
for (const mode of ['cold', 'reload']) {
  const baseline = median(runs.filter((r) => r.mode === mode && r.variant === 'baseline').map((r) => r.durationMs))
  const candidate = median(runs.filter((r) => r.mode === mode && r.variant === 'candidate').map((r) => r.durationMs))
  markdown += `| ${mode} | ${baseline.toFixed(1)} | ${candidate.toFixed(1)} | ${((candidate - baseline) / baseline * 100).toFixed(1)}% |\n`
}
await writeFile('results/summary.md', markdown)
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown)
console.log(markdown)
