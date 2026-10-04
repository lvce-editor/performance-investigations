import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'

const [checkout, workspace, output] = process.argv.slice(2)
if (!checkout || !workspace || !output) throw new Error('Usage: node src/graph-benchmark.ts <eslint-checkout> <workspace> <output.json>')
const base = resolve(checkout, 'packages/module-resolution-worker/src/parts')
const fs = await import(pathToFileURL(join(base, 'FileSystem/FileSystem.ts')).href)
const resolution = await import(pathToFileURL(join(base, 'ModuleResolution/ModuleResolution.ts')).href)
fs.state.api = {
  readFile: (uri: string) => readFile(fileURLToPath(uri), 'utf8'),
  readFileAsBase64: async (uri: string) => (await readFile(fileURLToPath(uri))).toString('base64'),
  readDirWithFileTypes: async (uri: string) => (await readdir(fileURLToPath(uri), { withFileTypes: true })).map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() })),
  stat: async (uri: string) => { const s = await stat(fileURLToPath(uri)); return { isDirectory: s.isDirectory(), isFile: s.isFile() } },
}
const started = performance.now()
const capture = await fs.captureFileReads(() => resolution.loadEslintConfig(resolve(workspace, 'eslint.config.js')))
if (capture.error) throw capture.error
const graph = capture.result
const stable = Object.fromEntries(['entry', 'files', 'lazyModules', 'modules', 'resolutions'].map((key) => [key, typeof graph[key] === 'object' ? Object.fromEntries(Object.entries(graph[key]).sort(([a], [b]) => a.localeCompare(b))) : graph[key]]))
const durationMs = performance.now() - started
const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc
gc?.()
const packages = new Map<string, { package: string; fileReads: number; contentChars: number }>()
for (const read of capture.reads) {
  const suffix = read.path.split('/node_modules/').at(-1)
  const name = suffix === read.path ? '<workspace>' : suffix.startsWith('@') ? suffix.split('/').slice(0, 2).join('/') : suffix.split('/')[0]
  const entry = packages.get(name) ?? { package: name, fileReads: 0, contentChars: 0 }
  entry.fileReads++
  entry.contentChars += read.contentLength ?? 0
  packages.set(name, entry)
}
const result = {
  durationMs,
  forcedGc: Boolean(gc),
  peakRssBytes: process.resourceUsage().maxRSS * 1024,
  fileReads: capture.reads.length,
  uniqueFiles: new Set(capture.reads.map((r: any) => r.path)).size,
  contentChars: capture.reads.reduce((sum: number, r: any) => sum + (r.contentLength ?? 0), 0),
  modules: Object.keys(graph.modules).length,
  lazyModules: Object.keys(graph.lazyModules).length,
  graphHash: createHash('sha256').update(JSON.stringify(stable)).digest('hex'),
  memory: process.memoryUsage(),
  packages: [...packages.values()].sort((a, b) => b.contentChars - a.contentChars),
  note: 'Node graph-only experiment; browser cache storage and IPC absent; not end-to-end startup latency',
}
await writeFile(output, JSON.stringify(result, null, 2) + '\n')
console.log(result)
