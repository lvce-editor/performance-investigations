import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

const [checkoutArg, workspaceArg, outputArg, repeatsArg = '5'] = process.argv.slice(2)
if (!outputArg) throw new Error('Usage: typescript-browser-benchmark.ts <extension> <workspace> <output-dir> [repeats]')
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
  const cold = await Command.executeExtensionCommand('typescript.showPerformanceTrace', { text, uri })
  if (cold.error || cold.languageService.cache !== 'created' || cold.diagnostics.count !== 0) throw new Error(JSON.stringify(cold))
  await FileSystem.writeFile(${JSON.stringify(pathToFileURL(coldOutput).href)}, JSON.stringify(cold))
  const warm = await Command.executeExtensionCommand('typescript.showPerformanceTrace', { text, uri })
  if (warm.error || warm.languageService.cache !== 'reused' || warm.diagnostics.count !== 0) throw new Error(JSON.stringify(warm))
  await FileSystem.writeFile(${JSON.stringify(pathToFileURL(warmOutput).href)}, JSON.stringify(warm))
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
    browser = await chromium.launch({ headless: true, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] })
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(`${url}/tests/typescript.benchmark.html`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    const overlay = page.locator('#TestOverlay')
    await overlay.waitFor({ state: 'visible', timeout: 120_000 })
    if (await overlay.getAttribute('data-state') !== 'pass') throw new Error(await overlay.textContent())
    for (const mode of ['cold', 'warm']) {
      const trace = JSON.parse(await readFile(mode === 'cold' ? coldOutput : warmOutput, 'utf8'))
      rows.push({ iteration, mode, trace }); console.log({ iteration, mode, totalDurationMs: trace.totalDurationMs, syncRpc: trace.syncRpc })
    }
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
await writeFile(join(output, 'browser-overview.json'), JSON.stringify({ schemaVersion: 1, repeats, rows, note: 'Unprofiled headless Chromium and LVCE server with only the TypeScript extension. Fresh browser and server per cold request; immediate warm request in same language service. Real SyncApi IPC and XHR libraries. Worker trace excludes extension activation, browser startup, and command output rendering. Not Electron startup latency.' }, null, 2) + '\n')
