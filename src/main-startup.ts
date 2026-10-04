import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { analyze } from './analyze.ts'

const [binary, workspace, file, output, duration = '10000'] = process.argv.slice(2)
const sampleMs = Number(duration)
if (!binary || !workspace || !file || !output || !Number.isSafeInteger(sampleMs) || sampleMs < 1000 || sampleMs > 30000) throw new Error('Usage: node src/main-startup.ts <electron-binary> <workspace> <file> <output> [sample-ms: 1000..30000]')
const root = resolve(output)
await mkdir(root, { recursive: false })
const env = { ...process.env }
for (const [key, value] of Object.entries({ XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data', XDG_CACHE_HOME: 'cache', XDG_STATE_HOME: 'state' })) {
  env[key] = join(root, 'runtime', value)
  await mkdir(env[key]!, { recursive: true })
}
const args = ['--inspect-brk=127.0.0.1:0', `--user-data-dir=${join(root, 'runtime/chromium')}`, resolve(workspace), '--open', file]
const child = spawn(resolve(binary), args, { env, cwd: resolve(workspace), detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
let stderr = '', stdout = '', socket: WebSocket | undefined
const endpoint = Promise.withResolvers<string>()
child.stdout.on('data', (data) => { stdout += data })
child.stderr.on('data', (data) => { stderr += data; const match = stderr.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/); if (match) endpoint.resolve(match[1]) })
child.once('error', endpoint.reject)
child.once('exit', (code) => endpoint.reject(new Error(`Electron exited ${code} before exposing its inspector`)))
const kill = (signal: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, signal) } catch (error: any) { if (error.code !== 'ESRCH') throw error } }
const watchdog = setTimeout(() => { endpoint.reject(new Error('Early-main capture timed out')); socket?.close(); kill('SIGTERM') }, 60000)
try {
  socket = new WebSocket(await endpoint.promise)
  await new Promise<void>((done, reject) => { const timer = setTimeout(() => reject(new Error('Inspector connection timeout')), 10000); socket!.addEventListener('open', () => { clearTimeout(timer); done() }, { once: true }); socket!.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Inspector connection failed')) }, { once: true }) })
  const paused = Promise.withResolvers<void>()
  const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>()
  const fail = (error: Error) => { for (const request of pending.values()) request.reject(error); pending.clear() }
  socket.addEventListener('close', () => fail(new Error('Inspector closed')))
  socket.addEventListener('error', () => fail(new Error('Inspector failed')))
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.method === 'Debugger.paused') paused.resolve()
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result)
  })
  let nextId = 0
  const invoke = async (method: string, params?: object) => {
    const id = ++nextId, result = Promise.withResolvers<any>()
    pending.set(id, result)
    const timer = setTimeout(() => { pending.delete(id); result.reject(new Error(`Inspector timeout: ${method}`)) }, 10000)
    socket!.send(JSON.stringify({ id, method, params }))
    try { return await result.promise } finally { clearTimeout(timer) }
  }
  await invoke('Debugger.enable')
  await invoke('Profiler.enable')
  await invoke('Profiler.start')
  await invoke('Runtime.runIfWaitingForDebugger')
  const pauseTimer = setTimeout(() => paused.reject(new Error('Expected an initial debugger pause')), 10000)
  try { await paused.promise } finally { clearTimeout(pauseTimer) }
  const before = await invoke('Runtime.evaluate', { expression: '({ now: globalThis.performance.now(), state: Object.fromEntries(["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"].map(key => [key, process.env[key]])) })', returnByValue: true })
  if (before.exceptionDetails || Object.entries(before.result?.value?.state ?? {}).some(([key, value]) => value !== env[key])) throw new Error('Child state isolation could not be verified')
  await invoke('Debugger.resume')
  await delay(sampleMs)
  const marks = await invoke('Runtime.evaluate', { expression: 'globalThis.performance.getEntriesByType("mark").map(e => ({ name: e.name, startTime: e.startTime }))', returnByValue: true })
  if (marks.exceptionDetails) throw new Error('Could not read main-process performance marks')
  const stopped = await invoke('Profiler.stop')
  const profile = join(root, 'main.cpuprofile')
  await writeFile(profile, JSON.stringify(stopped.profile))
  await writeFile(join(root, 'summary.json'), JSON.stringify(await analyze(profile), null, 2) + '\n')
  await writeFile(join(root, 'marks.json'), JSON.stringify({
    sampleMs, beforeResumePerformanceNow: before.result?.value?.now, childState: before.result?.value?.state, binary: resolve(binary), args, marks: marks.result?.value,
    method: 'Inspector attaches before application startup and samples the first interval after resume. Main-process JS includes pre-appReady work. Debugger startup perturbs timing and native Electron initialization may continue while paused; these are not unprofiled process-start milestones.',
  }, null, 2) + '\n')
  console.log(`Early main-process capture: ${root}`)
} finally {
  clearTimeout(watchdog)
  socket?.close()
  kill('SIGTERM'); await delay(300); kill('SIGKILL')
  await writeFile(join(root, 'stdout.log'), stdout)
  await writeFile(join(root, 'stderr.log'), stderr)
}
