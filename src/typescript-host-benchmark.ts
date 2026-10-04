import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, join, basename, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { Session } from 'node:inspector/promises'

const [mode, checkoutArg, workspaceArg, outputArg, profileArg] = process.argv.slice(2)
if (!['native', 'lvce'].includes(mode) || !outputArg) throw new Error('Usage: typescript-host-benchmark.ts <native|lvce> <extension> <workspace> <output.json> [profile.cpuprofile]')
const checkout = resolve(checkoutArg), workspace = resolve(workspaceArg), output = resolve(outputArg)
const require = createRequire(join(checkout, 'package.json'))
const ts = require('typescript')
const file = join(workspace, 'packages/about-view/src/aboutWorkerMain.ts')
const configPath = join(workspace, 'packages/about-view/tsconfig.json')
const base = join(checkout, 'packages/typescript-worker/src/parts')
const text = readFileSync(file, 'utf8')
const methods: Record<string, { calls: number; durationMs: number; bytes: number }> = {}
const queries = new Set<string>()
const physicalQueries = new Map<string, Set<string>>()
const invalidPaths = new Map<string, number>()
const timed = (method: string, path: string, callback: () => any) => {
  const entry = methods[method] ??= { calls: 0, durationMs: 0, bytes: 0 }
  entry.calls++
  queries.add(`${method}:${path}`)
  if (method.startsWith('SyncApi.')) {
    try {
      const key = `${method}:${toPath(path)}`
      const aliases = physicalQueries.get(key) ?? new Set<string>()
      aliases.add(path); physicalQueries.set(key, aliases)
    } catch {
      invalidPaths.set(path, (invalidPaths.get(path) ?? 0) + 1)
    }
  }
  const start = performance.now()
  try {
    const result = callback()
    if (typeof result === 'string') entry.bytes += Buffer.byteLength(result)
    return result
  } finally { entry.durationMs += performance.now() - start }
}
const sys = { ...ts.sys }
for (const method of ['readFile', 'fileExists', 'directoryExists', 'readDirectory', 'getDirectories', 'realpath']) {
  sys[method] = (path: string, ...args: any[]) => timed(method, path, () => ts.sys[method](path, ...args))
}
let libraryReads = 0
;(globalThis as any).XMLHttpRequest = class {
  url = ''; responseText = ''
  open(_method: string, url: string) { this.url = url }
  setRequestHeader() {}
  send() {
    libraryReads++
    this.responseText = timed('libraryRead', this.url, () => readFileSync(require.resolve(`typescript/lib/${basename(new URL(this.url).pathname)}`), 'utf8'))
  }
}
const toPath = (uri: string) => uri.startsWith('file:') ? fileURLToPath(uri) : resolve(workspace, uri)
const invokeSync = (method: string, uri: string) => timed(method, uri, () => {
  const path = toPath(uri)
  switch (method) {
    case 'SyncApi.exists': return existsSync(path)
    case 'SyncApi.readFileSync': return readFileSync(path, 'utf8')
    case 'SyncApi.readDirSync': return readdirSync(path)
    default: throw new Error(`Unexpected method ${method}`)
  }
})
const imports: any = {}
if (mode === 'lvce') {
  for (const name of ['LanguageServices', 'CreateFileSystem', 'Diagnostics2', 'GetOrCreateLanguageService', 'PerformanceTrace']) {
    imports[name] = await import(pathToFileURL(join(base, `${name}/${name}.ts`)).href)
  }
  imports.LanguageServices.set(1, imports.CreateFileSystem.createFileSystem(), { invokeSync }, ts)
}
const stages: Record<string, number> = {}
const measure = (name: string, callback: () => any) => {
  const start = performance.now()
  try { return callback() } finally { stages[name] = performance.now() - start }
}
const inspector = profileArg ? new Session() : undefined
if (inspector) {
  inspector.connect()
  await inspector.post('Profiler.enable')
  await inspector.post('Profiler.setSamplingInterval', { interval: 1000 })
  await inspector.post('Profiler.start')
}
ts.performance.enable()
const cpuStart = process.cpuUsage(), start = performance.now()
let diagnostics: any[], program: any, trace: any, options: any, rootFiles: string[]
if (mode === 'native') {
  const config = measure('config', () => {
    const parsed = ts.readConfigFile(configPath, sys.readFile)
    if (parsed.error) throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'))
    const result = ts.parseJsonConfigFileContent(parsed.config, sys, resolve(configPath, '..'), undefined, configPath)
    if (result.errors.length) throw new Error(JSON.stringify(result.errors))
    return result
  })
  options = config.options; rootFiles = config.fileNames
  const host = {
    ...sys,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getCurrentDirectory: () => workspace,
    getCompilationSettings: () => options,
    getScriptFileNames: () => rootFiles,
    getScriptVersion: () => '1',
    getProjectVersion: () => '1',
    getDefaultLibFileName: (settings: any) => ts.getDefaultLibFilePath(settings),
    getScriptSnapshot: (path: string) => {
      const source = sys.readFile(path)
      return source === undefined ? undefined : ts.ScriptSnapshot.fromString(source)
    },
  }
  const service = measure('languageServiceCreation', () => ts.createLanguageService(host))
  diagnostics = measure('semanticDiagnostics', () => service.getSemanticDiagnostics(file)).map((d: any) => ({ code: d.code, start: d.start, length: d.length, message: ts.flattenDiagnosticMessageText(d.messageText, '\n') }))
  program = service.getProgram()
} else {
  const uri = pathToFileURL(file).href
  trace = imports.PerformanceTrace.createPerformanceTrace(uri)
  diagnostics = await imports.Diagnostics2.getDiagnostics2({ uri, text, languageId: 'typescript', version: 1 }, trace)
  program = imports.GetOrCreateLanguageService.getOrCreateLanguageService(uri).languageService.getProgram()
  options = program.getCompilerOptions(); rootFiles = program.getRootFileNames()
}
const durationMs = performance.now() - start, cpu = process.cpuUsage(cpuStart)
const compilerMeasures: Record<string, number> = {}
ts.performance.forEachMeasure((name: string, value: number) => { compilerMeasures[name] = value })
if (inspector) {
  const { profile } = await inspector.post('Profiler.stop')
  inspector.disconnect()
  writeFileSync(resolve(profileArg), JSON.stringify(profile))
}
const normalizedPath = (path: string) => {
  if (path.startsWith('lib.') && !path.includes('/')) return `typescript/lib/${path}`
  const actual = toPath(path)
  if (actual.startsWith(workspace + '/')) return relative(workspace, actual)
  if (actual.includes('/typescript/lib/')) return `typescript/lib/${basename(actual)}`
  if (!actual.includes('/') && actual.startsWith('lib.')) return `typescript/lib/${actual}`
  if (basename(actual).startsWith('lib.') && !existsSync(actual)) return `typescript/lib/${basename(actual)}`
  return actual
}
const loadedFiles = program.getSourceFiles().map((source: any) => ({
  path: normalizedPath(source.fileName), bytes: Buffer.byteLength(source.text),
  sha256: createHash('sha256').update(source.text).digest('hex'), declaration: source.isDeclarationFile,
})).sort((a: any,b: any) => a.path.localeCompare(b.path))
const summary = {
  schemaVersion: 1, mode, nodeVersion: process.version, typescriptVersion: ts.version,
  durationMs, cpuMs: { user: cpu.user / 1000, system: cpu.system / 1000 }, stages, compilerMeasures,
  methods, uniqueQueries: queries.size, libraryReads, trace, diagnostics, options,
  physicalQueryCount: physicalQueries.size,
  invalidPaths: Object.fromEntries(invalidPaths),
  aliasedQueries: [...physicalQueries].filter(([,aliases]) => aliases.size > 1).map(([path,aliases]) => ({ path, aliases: [...aliases] })),
  rootFiles: rootFiles.map(normalizedPath).sort(), loadedFiles, memory: process.memoryUsage(),
  note: 'Fresh process and language service; one semantic diagnostic request. Direct Node filesystem, no IPC. Timer excludes loading TypeScript and harness modules, includes config and program initialization. Filesystem timings are synchronous wall time; compiler measures can overlap.',
}
writeFileSync(output, JSON.stringify(summary, null, 2) + '\n')
console.log({ mode, durationMs, compilerMeasures, diagnostics: diagnostics.length, rootFiles: rootFiles.length, loadedFiles: loadedFiles.length, methods })
