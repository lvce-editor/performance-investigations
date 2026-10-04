import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { reconstruct, summarize, type Profile } from './profiles.ts'

export const analyze = async (input: string, windowMs?: number) => {
  const data = JSON.parse(await readFile(input, 'utf8'))
  let profiles: Profile[]
  let excluded: string[] = []
  if (Array.isArray(data.traceEvents)) ({ profiles, excluded } = reconstruct(data.traceEvents))
  else if (Array.isArray(data.nodes)) profiles = [data]
  else throw new Error('Expected Chromium traceEvents or V8 CPU profile nodes')
  if (!profiles.length) throw new Error('No CPU profiles found')
  const origin = Math.min(...profiles.map((p) => p.startTime))
  return {
    schemaVersion: 2,
    method: 'Timestamp-ordered sample residency; non-idle time is an estimate, not OS CPU time or startup latency. Inclusive rows overlap. First sample gap is unobserved.',
    traceDurationMs: (Math.max(...profiles.map((p) => p.endTime ?? p.startTime + p.timeDeltas.reduce((a, b) => a + b, 0))) - origin) / 1000,
    windowMs: windowMs ?? null, excludedDuplicateProfiles: excluded,
    browserMilestones: (data.traceEvents ?? []).filter((event: any) =>
      ['firstPaint', 'firstContentfulPaint', 'largestContentfulPaint::Candidate'].includes(event.name) &&
      event.ts >= origin && (windowMs === undefined || event.ts <= origin + windowMs * 1000)
    ).map((event: any) => ({
      name: event.name, offsetMs: (event.ts - origin) / 1000, pid: event.pid, tid: event.tid,
      frame: event.args?.frame ?? event.args?.data?.frame ?? null,
      navigationId: event.args?.data?.navigationId ?? null,
      nodeName: event.args?.data?.nodeName ?? null,
      isMainFrame: event.args?.data?.isMainFrame ?? null,
    })).sort((a: any, b: any) => a.offsetMs - b.offsetMs),
    profiles: profiles.map((p) => summarize(p, origin, windowMs)).sort((a, b) => b.nonIdleMs - a.nonIdleMs),
  }
}

const main = async () => {
  const [input, output, window] = process.argv.slice(2)
  if (!input || !output) throw new Error('Usage: npm run analyze -- <trace-or-directory> <summary.json> [window-ms]')
  const windowMs = window === undefined ? undefined : Number(window)
  if (windowMs !== undefined && (!Number.isFinite(windowMs) || windowMs <= 0)) throw new Error('Window must be positive milliseconds')
  let path = resolve(input)
  let manifest: any
  try {
    manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'))
    // Original capture was manually renamed from trace.json to trace.cpuprofile.
    const files = await readdir(path)
    const trace = files.includes(manifest.trace) ? manifest.trace : files.includes('trace.cpuprofile') ? 'trace.cpuprofile' : undefined
    if (!trace) throw new Error('Manifest trace file is missing')
    path = join(path, trace)
  } catch (error: any) {
    if (error.code !== 'ENOTDIR' && error.code !== 'ENOENT') throw error
  }
  const result = { ...await analyze(path, windowMs), captureErrors: manifest?.errors ?? [] }
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`)
  for (const profile of result.profiles) console.log(`${profile.nonIdleMs.toFixed(1).padStart(9)} ms non-idle | ${profile.role}`)
  if (result.captureErrors.length) throw new Error(`Capture failed: ${result.captureErrors.join('; ')}`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1 })
}
