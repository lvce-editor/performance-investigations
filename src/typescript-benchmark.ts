import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve, join, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const [checkout, workspace, output] = process.argv.slice(2)
if (!checkout || !workspace || !output) throw new Error('Usage: node src/typescript-benchmark.ts <typescript-extension-checkout> <workspace> <output.json>')
const base = resolve(checkout, 'packages/typescript-worker/src/parts')
const require = createRequire(resolve(checkout, 'package.json'))
const ts = require('typescript')
let libraryReads = 0
// Map the worker's bundled-library XHR fallback to the same installed TS libs.
// This is a transport adapter for the Node count experiment, not a browser mock.
;(globalThis as any).XMLHttpRequest = class {
  url = ''
  responseText = ''
  open(_method: string, url: string) { this.url = url }
  setRequestHeader() {}
  send() {
    libraryReads++
    this.responseText = readFileSync(require.resolve(`typescript/lib/${basename(new URL(this.url).pathname)}`), 'utf8')
  }
}

const services = await import(pathToFileURL(join(base, 'LanguageServices/LanguageServices.ts')).href)
const { createFileSystem } = await import(pathToFileURL(join(base, 'CreateFileSystem/CreateFileSystem.ts')).href)
const diagnostics = await import(pathToFileURL(join(base, 'Diagnostics2/Diagnostics2.ts')).href)
const counts = new Map<string, number>(), queries = new Map<string, number>()
const toPath = (uri: string) => uri.startsWith('file:') ? fileURLToPath(uri) : resolve(workspace, uri)
const invokeSync = (method: string, uri: string) => {
  counts.set(method, (counts.get(method) ?? 0) + 1)
  const key = `${method}:${uri}`
  queries.set(key, (queries.get(key) ?? 0) + 1)
  const path = toPath(uri)
  switch (method) {
    case 'SyncApi.exists': return existsSync(path)
    case 'SyncApi.readFileSync': return readFileSync(path, 'utf8')
    case 'SyncApi.readDirSync': return readdirSync(path)
    default: throw new Error(`Unexpected sync request ${method}`)
  }
}
services.set(1, createFileSystem(), { invokeSync }, ts)
const file = resolve(workspace, 'packages/about-view/src/aboutWorkerMain.ts')
const document = { uri: pathToFileURL(file).href, text: readFileSync(file, 'utf8'), languageId: 'typescript', version: 1 }
const started = performance.now()
const result = await diagnostics.getDiagnostics2(document)
const durationMs = performance.now() - started
const initialMethods = Object.fromEntries(counts), initialRequests = [...counts.values()].reduce((a,b) => a+b, 0)
const edited = await diagnostics.getDiagnostics2({ ...document, version: 2, text: document.text + '\nconst startupPerformanceError: string = 123\n' })
if (!edited.some((item: any) => item.message?.includes('not assignable'))) throw new Error('Expected type error after document edit')
const restored = await diagnostics.getDiagnostics2({ ...document, version: 3 })
if (JSON.stringify(restored) !== JSON.stringify(result)) throw new Error('Diagnostics changed after restoring document')
const hash = createHash('sha256').update(JSON.stringify(result)).digest('hex')
const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc
gc?.()
const summary = {
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(checkout), encoding: 'utf8' }).trim(), nodeVersion: process.version, typescriptVersion: ts.version,
  durationMs, libraryReads, initialMethods, initialRequests, methods: Object.fromEntries(counts), totalRequests: [...counts.values()].reduce((a,b) => a+b, 0), uniqueRequests: queries.size,
  duplicateRequests: [...queries.values()].reduce((sum, count) => sum + count - 1, 0),
  diagnostics: result, diagnosticsHash: hash, editedDiagnostics: edited, restoredDiagnostics: restored, memory: process.memoryUsage(),
  note: 'Diagnostics through the real extension host/resolver with direct Node filesystem transport. Counts represent actual underlying queries; no browser IPC latency is simulated. Not editor startup latency.',
}
await writeFile(output, JSON.stringify(summary, null, 2) + '\n')
console.log({ sourceCommit: summary.sourceCommit, durationMs, initialMethods, initialRequests, totalRequestsIncludingEdits: summary.totalRequests, diagnostics: result.length, editedDiagnostics: edited.length, restoredDiagnostics: restored.length, diagnosticsHash: hash })
