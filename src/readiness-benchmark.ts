import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [harnessCheckout, extensionCheckout, workspace, output] = process.argv.slice(2)
if (!harnessCheckout || !extensionCheckout || !workspace || !output) throw new Error('Usage: node src/readiness-benchmark.ts <fixed-eslint-harness-checkout> <extension-checkout> <workspace> <output.json>')
const harness = resolve(harnessCheckout)
const require = createRequire(join(harness, 'packages/benchmark/package.json'))
const { chromium } = require('playwright')
const helpers = join(harness, 'packages/benchmark/src')
const { startServer } = await import(pathToFileURL(join(helpers, 'server.ts')).href)
const { createBenchmarkTest } = await import(pathToFileURL(join(helpers, 'benchmarkTest.ts')).href)
const { resolveBenchmarkFile } = await import(pathToFileURL(join(helpers, 'repository.ts')).href)
await mkdir(join(harness, '.tmp'), { recursive: true })
const testDirectory = await mkdtemp(join(harness, '.tmp', 'readiness-benchmark-'))
let browser: any, server: any
try {
  const filePath = await resolveBenchmarkFile(resolve(workspace), 'packages/about-view/src/aboutWorkerMain.ts')
  await createBenchmarkTest(testDirectory, resolve(workspace), filePath)
  server = await startServer({ extensionPath: resolve(extensionCheckout, 'packages/extension'), serverPath: require.resolve('@lvce-editor/server/bin/server.js'), testPath: testDirectory, timeout: 180000, workspace: resolve(workspace) })
  browser = await chromium.launch({ headless: true, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] })
  const context = await browser.newContext({ viewport: { height: 720, width: 1280 } })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error: Error) => errors.push(error.message))
  const url = new URL('/tests/eslint.benchmark.html', server.url).href
  const durations: Record<string, number> = {}
  for (const mode of ['cold', 'reload']) {
    const started = performance.now()
    if (mode === 'cold') await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 })
    else await page.reload({ waitUntil: 'domcontentloaded', timeout: 180000 })
    const overlay = page.locator('#TestOverlay')
    await overlay.waitFor({ state: 'visible', timeout: 180000 })
    durations[mode] = performance.now() - started
    if (await overlay.getAttribute('data-state') !== 'pass') throw new Error(await overlay.textContent())
  }
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`)
  const result = { durationsMs: durations, errors, method: 'No tracing or profiler enabled. Fresh-browser test-overlay readiness and same-context warmed reload, using one fixed benchmark harness. Includes opening the file and ESLint command; not first-paint or Electron-process startup.' }
  await writeFile(output, JSON.stringify(result, null, 2) + '\n')
  console.log(result)
} finally {
  try { await browser?.close() } finally {
    try { await server?.close() } finally { await rm(testDirectory, { recursive: true, force: true }) }
  }
}
