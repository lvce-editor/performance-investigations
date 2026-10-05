import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { CompilerPathMap } from './compiler-path-map.ts'

const [mode, checkoutArg, workspaceArg, outputArg] = process.argv.slice(2)
if (!['native', 'uri', 'uri-cached', 'mapped'].includes(mode) || !outputArg) throw new Error('Usage: typescript-path-host.ts <native|uri|uri-cached|mapped> <TS checkout> <about-view> <output.json>')
const workspace = resolve(workspaceArg), require = createRequire(resolve(checkoutArg, 'package.json')), ts = require('typescript')
const map = new CompilerPathMap(), paths = new Map<string, string>(), names = new Map<string, string>()
let conversions = 0, conversionMs = 0, conversionCacheHits = 0
const toNative = (path: string) => {
  if (mode === 'native') return path
  if (mode !== 'uri') {
    const known = paths.get(path)
    if (known !== undefined) { conversionCacheHits++; return known }
  }
  const start = performance.now()
  try {
    const actual = fileURLToPath(mode === 'mapped' ? map.toUri(path) : path)
    conversions++; if (mode !== 'uri') paths.set(path, actual)
    return actual
  } finally { conversionMs += performance.now() - start }
}
const toCompiler = (path: string) => {
  if (mode === 'native') return path
  const known = names.get(path)
  if (known !== undefined) return known
  const uri = pathToFileURL(path).href, result = mode === 'mapped' ? map.toCompiler(uri) : uri
  names.set(path, result); if (mode !== 'uri') paths.set(result, path)
  return result
}
const methods: Record<string, { calls: number; ms: number }> = {}
const requests = new Set<string>()
const call = (method: string, path: string, ...args: any[]) => {
  const entry = methods[method] ??= { calls: 0, ms: 0 }
  entry.calls++; requests.add(`${method}:${path}`)
  const start = performance.now()
  try { return ts.sys[method](toNative(path), ...args) } finally { entry.ms += performance.now() - start }
}
const currentDirectory = toCompiler(workspace)
const configFile = toCompiler(join(workspace, 'packages/about-view/tsconfig.json'))
const sys = {
  useCaseSensitiveFileNames: true,
  readFile: (path: string) => call('readFile', path),
  fileExists: (path: string) => call('fileExists', path),
  directoryExists: (path: string) => call('directoryExists', path),
  getDirectories: (path: string) => call('getDirectories', path),
  realpath: (path: string) => toCompiler(call('realpath', path)),
  readDirectory: (path: string, ...args: any[]) => call('readDirectory', path, ...args).map(toCompiler),
}
ts.performance.enable()
const start = performance.now(), cpuStart = process.cpuUsage()
const config = ts.readConfigFile(configFile, sys.readFile)
if (config.error) throw new Error(JSON.stringify(config.error))
const parsed = ts.parseJsonConfigFileContent(config.config, sys, ts.getDirectoryPath(configFile), undefined, configFile)
if (parsed.errors.length) throw new Error(JSON.stringify(parsed.errors))
const service = ts.createLanguageService({
  ...sys, useCaseSensitiveFileNames: () => true, getCurrentDirectory: () => currentDirectory,
  getCompilationSettings: () => parsed.options,
  getScriptFileNames: () => parsed.fileNames, getScriptVersion: () => '1', getProjectVersion: () => '1',
  getDefaultLibFileName: (options: any) => toCompiler(ts.getDefaultLibFilePath(options)),
  getScriptSnapshot: (path: string) => { const text = sys.readFile(path); return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text) },
})
const file = toCompiler(join(workspace, 'packages/about-view/src/aboutWorkerMain.ts'))
const diagnostics = service.getSemanticDiagnostics(file).map((item: any) => ({ code: item.code, start: item.start, length: item.length, message: ts.flattenDiagnosticMessageText(item.messageText, '\n') }))
const program = service.getProgram()
const durationMs = performance.now() - start, cpu = process.cpuUsage(cpuStart)
const measures: Record<string, number> = {}
ts.performance.forEachMeasure((name: string, value: number) => { measures[name] = value })
const measuredConversions = conversions, measuredConversionMs = conversionMs, measuredHits = conversionCacheHits
const graph = program.getSourceFiles().map((source: any) => ({ path: toNative(source.fileName), sha256: createHash('sha256').update(source.text).digest('hex') })).sort((a: any,b: any) => a.path.localeCompare(b.path))
const result = {
  schemaVersion: 1, mode, typescriptVersion: ts.version, nodeVersion: process.version, durationMs,
  cpuMs: { user: cpu.user / 1000, system: cpu.system / 1000 }, measures, methods, uniqueRequests: requests.size,
  conversions: measuredConversions, conversionMs: measuredConversionMs, conversionCacheHits: measuredHits,
  diagnostics, rootCount: parsed.fileNames.length, graph, graphHash: createHash('sha256').update(JSON.stringify(graph)).digest('hex'),
  note: 'Standard TypeScript language service and resolver, direct Node filesystem, one opened-file diagnostic. Fresh process. Timer includes config/program creation, excludes loading compiler/harness and final graph hashing. Conversion time is instrumented wall time, not exclusive CPU. No IPC or production LVCE adapter.',
}
writeFileSync(resolve(outputArg), JSON.stringify(result, null, 2) + '\n')
console.log({ mode, durationMs, diagnostics, conversions: measuredConversions, conversionMs: measuredConversionMs, conversionCacheHits: measuredHits, rootCount: parsed.fileNames.length, loadedFiles: graph.length })
