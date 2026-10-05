import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

const [checkoutArg, workspaceArg, outputArg, repeatsArg = '5'] = process.argv.slice(2)
if (!outputArg) throw new Error('Usage: typescript-seven-browser.ts <extension> <workspace> <output-dir> [repeats]')
const checkout = resolve(checkoutArg), workspace = resolve(workspaceArg), output = resolve(outputArg)
const repeats = Number(repeatsArg)
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error('Repeats must be 1 to 20')
const require = createRequire(join(checkout, 'package.json'))
const { chromium } = require('playwright')
const serverPath = require.resolve('@lvce-editor/server-smart-selection/bin/server.js')
await mkdir(output, { recursive: true })
const rows: any[] = []
for (let iteration = 0; iteration < repeats; iteration++) {
  const testDirectory = await mkdtemp(join(output, 'browser-runtime-'))
  const coldOutput = join(output, `browser-${iteration}-cold.json`), warmOutput = join(output, `browser-${iteration}-warm.json`)
  const portServer = createServer()
  await new Promise<void>((done, reject) => { portServer.once('error', reject); portServer.listen(0, '127.0.0.1', done) })
  const address = portServer.address()
  if (!address || typeof address === 'string') throw new Error('Missing port')
  await new Promise<void>((done, reject) => portServer.close(error => error ? reject(error) : done()))
  const env = { ...process.env, PORT: String(address.port), FOLDER: workspace }
  for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
    env[key] = join(testDirectory, key); await mkdir(env[key], { recursive: true })
  }
  await mkdir(join(testDirectory, 'src'))
  await writeFile(join(testDirectory, 'src/typescript.benchmark.ts'), `export const name = 'typescript.benchmark'
export const test = async ({ Command, FileSystem, Main, Settings }) => {
  await Settings.update({ 'editor.diagnostics': false })
  await Command.execute('Workspace.setUri', ${JSON.stringify(pathToFileURL(workspace).href)})
  const uri = ${JSON.stringify(pathToFileURL(join(workspace, 'packages/about-view/src/aboutWorkerMain.ts')).href)}
  await Main.openUri(uri)
  const text = await FileSystem.readFile(uri)
  const samples = []
  const invoke = async (kind, text, edited) => {
    const start = performance.now()
    const trace = await Command.executeExtensionCommand('typescript.benchmarkDiagnostics', { text, uri, languageId: 'typescript' })
    const roundTripMs = performance.now() - start
    if (trace.error || (kind === 'cold' ? trace.languageService.cache !== 'created' : trace.languageService.cache !== 'reused')) throw new Error(JSON.stringify(trace))
    if (trace.diagnostics.count !== (edited ? 1 : 0)) throw new Error(JSON.stringify(trace))
    samples.push({ kind, durationMs: roundTripMs, workerDurationMs: trace.totalDurationMs, trace })
    console.log(JSON.stringify({ kind, durationMs: roundTripMs, workerDurationMs: trace.totalDurationMs }))
  }
  await invoke('cold', text, false)
  for (let index = 0; index < 15; index++) {
    const kind = index < 5 ? 'unchanged' : (index - 5) % 2 ? 'restore' : 'edit'
    await invoke(kind, kind === 'edit' ? text + '\\nconst startupPerformanceError: string = 123; void startupPerformanceError\\n' : text, kind === 'edit')
  }
  const offset = text.lastIndexOf('Main.main') + 'Main.'.length
  if (offset < 'Main.'.length) throw new Error('Missing completion/reference target')
  for (const feature of ['completion', 'references']) {
    for (let index = 0; index < 5; index++) {
      const before = performance.now()
      const response = await Command.executeExtensionCommand(feature === 'completion' ? 'typescript.benchmarkCompletion' : 'typescript.benchmarkReferences', { text, uri, languageId: 'typescript', version: 20 }, offset)
      const durationMs = performance.now() - before
      const result = feature === 'completion' ? response.map(item => item.label).sort() : response.map(item => ({ uri: item.uri, range: { start: { line: item.startRowIndex, character: item.startColumnIndex }, end: { line: item.endRowIndex, character: item.endColumnIndex } } }))
      if (feature === 'completion' ? !result.includes('main') : !result.length) throw new Error('Missing ' + feature + ' result')
      samples.push({ kind: feature + (index === 0 ? '-first' : ''), durationMs, result })
      console.log(JSON.stringify({ kind: feature, durationMs }))
    }
  }
  await FileSystem.writeFile(${JSON.stringify(pathToFileURL(coldOutput).href)}, JSON.stringify(samples))
}
`)
  const child = spawn(process.execPath, [serverPath, workspace, `--only-extension=${join(checkout, 'packages/extension')}`, `--test-path=${testDirectory}`], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = '', childError: Error | undefined, browser: any
  child.stdout.on('data', data => { log += data })
  child.stderr.on('data', data => { log += data })
  child.once('error', error => { childError = error })
  const exited = new Promise<void>(done => child.once('exit', () => done()))
  const kill = (signal: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, signal) } catch (error: any) { if (error.code !== 'ESRCH') throw error } }
  try {
    const url = `http://localhost:${address.port}`
    const start = performance.now()
    let ready = false
    while (performance.now() - start < 60_000) {
      if (childError || child.exitCode !== null || child.signalCode !== null) throw new Error(`Server exited: ${childError ?? log}`)
      try { const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); await response.body?.cancel(); if (response.status < 500) { ready = true; break } } catch {}
      await delay(100)
    }
    if (!ready) throw new Error(`Server readiness timeout: ${log}`)
    browser = await chromium.launch({ env, headless: true, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] })
    const context = await browser.newContext()
    const page = await context.newPage()
    page.on('console', message => { log += `browser: ${message.text()}\n` })
    page.on('pageerror', error => { log += `pageerror: ${error}\n` })
    await page.goto(`${url}/tests/typescript.benchmark.html`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    const overlay = page.locator('#TestOverlay')
    await overlay.waitFor({ state: 'visible', timeout: 360_000 })
    if (await overlay.getAttribute('data-state') !== 'pass') throw new Error(await overlay.textContent())
    const samples = JSON.parse(await readFile(coldOutput, 'utf8'))
    rows.push({ iteration, samples })
    console.log({ iteration, cold: samples[0].durationMs, samples: samples.length })
  } finally {
    try { await browser?.close() } finally {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        kill('SIGTERM')
        const stopped = await Promise.race([exited.then(() => true), delay(5000).then(() => false)])
        if (!stopped) { kill('SIGKILL'); await exited }
      }
      await writeFile(join(output, `browser-${iteration}-server.log`), log)
      await rm(testDirectory, { recursive: true, force: true })
    }
  }
}
await writeFile(join(output, 'browser-overview.json'), JSON.stringify({ schemaVersion: 1, repeats, rows, note: 'Unprofiled headless Chromium and LVCE server with only the TypeScript extension. Fresh browser and server per cold request; five unchanged requests and five edit/restore pairs in the same language service. Real SyncApi IPC and XHR libraries. Worker trace excludes extension activation, browser startup, and command output rendering. Not Electron startup latency.' }, null, 2) + '\n')
