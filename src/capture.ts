import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { cpus, platform, release, totalmem } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { analyze } from './analyze.ts'

const [binary, workspace, file, output, timeoutArg = '240000'] = process.argv.slice(2)
if (!binary || !workspace || !file || !output) throw new Error('Usage: npm run capture -- <lvce-cli> <workspace> <relative-file> <output-directory> [timeout-ms]')
const timeout = Number(timeoutArg)
if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error('Timeout must be a positive integer')
const root = resolve(output)
await mkdir(root, { recursive: false })
const runtime = join(root, 'runtime')
const env = { ...process.env }
for (const [key, directory] of Object.entries({ XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data', XDG_CACHE_HOME: 'cache', XDG_STATE_HOME: 'state' })) {
  env[key] = join(runtime, directory)
  await mkdir(env[key]!, { recursive: true })
}
// --cpu-profile creates its own unique Chromium userData/sessionData directory.
// The XDG paths above isolate LVCE state as well. HOME and credentials stay intact.
const args = [resolve(workspace), '--open', file, '--cpu-profile', '--cpu-profile-dir', root]
const startedAt = performance.now()
const child = spawn(resolve(binary), args, { cwd: resolve(workspace), env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
let stdout = '', stderr = '', timedOut = false
child.stdout.on('data', (chunk) => { stdout += chunk })
child.stderr.on('data', (chunk) => { stderr += chunk })
const kill = (signal: NodeJS.Signals) => {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch (error: any) { if (error.code !== 'ESRCH') throw error }
}
let force: ReturnType<typeof setTimeout> | undefined
const timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); force = setTimeout(() => kill('SIGKILL'), 2000) }, timeout)
let exitCode: number | null = null
let captureElapsedMs = 0
try {
  exitCode = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', done) })
  captureElapsedMs = performance.now() - startedAt
  if (timedOut || exitCode !== 0) throw new Error(`Capture ${timedOut ? 'timed out' : `exited ${exitCode}`}: ${stderr.slice(-2000)}`)
  const entries = (await readdir(root)).filter((entry) => entry.startsWith('lvce-cpu-'))
  if (entries.length !== 1) throw new Error(`Expected one profile directory, got ${entries.length}`)
  const directory = join(root, entries[0])
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  if (manifest.errors?.length || !manifest.trace) throw new Error(`Invalid capture: ${JSON.stringify(manifest)}`)
  const summary = await analyze(join(directory, manifest.trace))
  await writeFile(join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  console.log(`Capture analyzed: ${root}`)
} finally {
  clearTimeout(timer); clearTimeout(force)
  kill('SIGTERM'); await delay(100); kill('SIGKILL')
  await writeFile(join(root, 'stdout.log'), stdout)
  await writeFile(join(root, 'stderr.log'), stderr)
  await writeFile(join(root, 'capture.json'), JSON.stringify({
    binary: resolve(binary), workspace: resolve(workspace), file, args,
    exitCode, timedOut, elapsedMs: captureElapsedMs, pipelineElapsedMs: performance.now() - startedAt,
    node: process.version, platform: platform(), kernel: release(), cpu: cpus()[0]?.model, cores: cpus().length, totalmem: totalmem(),
    state: 'fresh isolated XDG and Chromium profile; OS filesystem caches uncontrolled',
  }, null, 2) + '\n')
}
