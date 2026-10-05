import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [mode, compilerArg, workspaceArg, outputArg] = process.argv.slice(2)
if (!['ts6', 'ts7'].includes(mode) || !outputArg) throw new Error('Usage: typescript-seven-service.ts <ts6|ts7> <compiler-package> <workspace> <output>')
const compiler = resolve(compilerArg), workspace = resolve(workspaceArg), output = resolve(outputArg)
const file = join(workspace, 'packages/about-view/src/aboutWorkerMain.ts'), uri = pathToFileURL(file).href
const original = await readFile(file, 'utf8')
const errorText = original + '\nconst startupPerformanceError: string = 123; void startupPerformanceError\n'
const samples: any[] = []
const verify = (items: any[], edited: boolean) => {
  if (edited ? !items.some(item => item.code === 2322) : items.length !== 0) throw new Error(`Unexpected ${edited ? 'edited' : 'original'} diagnostics: ${JSON.stringify(items)}`)
}
let metadata: any
if (mode === 'ts6') {
  const require = createRequire(join(compiler, 'package.json'))
  const ts = require(compiler)
  const configPath = join(workspace, 'packages/about-view/tsconfig.json')
  let text = original, version = 1
  const start = performance.now()
  const raw = ts.readConfigFile(configPath, ts.sys.readFile)
  if (raw.error) throw new Error(JSON.stringify(raw.error))
  const config = ts.parseJsonConfigFileContent(raw.config, ts.sys, join(workspace, 'packages/about-view'), undefined, configPath)
  if (config.errors.length) throw new Error(JSON.stringify(config.errors))
  const service = ts.createLanguageService({
    ...ts.sys,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getCurrentDirectory: () => workspace,
    getCompilationSettings: () => config.options,
    getScriptFileNames: () => config.fileNames,
    getScriptVersion: (name: string) => name === file ? String(version) : '1',
    getProjectVersion: () => String(version),
    getDefaultLibFileName: (options: any) => ts.getDefaultLibFilePath(options),
    getScriptSnapshot: (name: string) => {
      const source = name === file ? text : ts.sys.readFile(name)
      return source === undefined ? undefined : ts.ScriptSnapshot.fromString(source)
    },
  })
  const request = () => service.getSemanticDiagnostics(file).map((d: any) => ({ code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, '\n') }))
  const cold = request()
  samples.push({ kind: 'cold', durationMs: performance.now() - start, diagnostics: cold }); verify(cold, false)
  for (let index = 0; index < 15; index++) {
    const kind = index < 5 ? 'unchanged' : (index - 5) % 2 ? 'restore' : 'edit'
    const before = performance.now()
    if (kind !== 'unchanged') { text = kind === 'edit' ? errorText : original; version++ }
    const diagnostics = request()
    samples.push({ kind, durationMs: performance.now() - before, diagnostics }); verify(diagnostics, kind === 'edit')
  }
  metadata = { version: ts.version, rootFiles: config.fileNames, loadedFiles: service.getProgram().getSourceFiles().map((s: any) => s.fileName) }
  service.dispose()
} else {
  const { default: getExePath } = await import(pathToFileURL(join(compiler, 'lib/getExePath.js')).href)
  const launchStart = performance.now()
  const child = spawn(getExePath(), ['--lsp', '--stdio'], { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = Buffer.alloc(0), nextId = 1, log = ''
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; method: string; timer: ReturnType<typeof setTimeout> }>()
  const send = (message: any) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }))
    child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]))
  }
  const fail = (error: Error) => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error) }; pending.clear() }
  child.on('error', fail)
  child.on('exit', (code, signal) => fail(new Error(`LSP exited ${code}/${signal}: ${log}`)))
  child.stderr.on('data', chunk => { log += chunk })
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk])
    while (true) {
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      const match = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())
      if (!match) { fail(new Error('Invalid LSP frame')); child.kill(); return }
      const length = Number(match[1])
      if (buffer.length < end + 4 + length) return
      const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString())
      buffer = buffer.subarray(end + 4 + length)
      if (message.method && message.id !== undefined) {
        // This client supplies no per-resource overrides or dynamic features.
        send({ id: message.id, result: message.method === 'workspace/configuration' ? message.params.items.map(() => ({})) : null })
      } else if (message.id !== undefined) {
        const item = pending.get(message.id)
        if (item) { clearTimeout(item.timer); pending.delete(message.id); message.error ? item.reject(new Error(`${item.method}: ${JSON.stringify(message.error)}`)) : item.resolve(message.result) }
      }
    }
  })
  const request = (method: string, params: any) => new Promise<any>((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`LSP timeout: ${method}: ${log}`)) }, 120_000)
    pending.set(id, { resolve, reject, timer, method }); send({ id, method, params })
  })
  try {
    const initialize = await request('initialize', { processId: process.pid, rootUri: pathToFileURL(workspace).href,
      workspaceFolders: [{ uri: pathToFileURL(workspace).href, name: 'about-view' }],
      capabilities: { textDocument: { diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false } } } })
    send({ method: 'initialized', params: {} })
    const start = performance.now()
    send({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'typescript', version: 1, text: original } } })
    const pull = async () => {
      const result = await request('textDocument/diagnostic', { textDocument: { uri } })
      if (result.kind !== 'full') throw new Error(`Expected full diagnostics: ${JSON.stringify(result)}`)
      return result.items
    }
    const cold = await pull()
    samples.push({ kind: 'cold', durationMs: performance.now() - start, launchToDiagnosticsMs: performance.now() - launchStart, diagnostics: cold }); verify(cold, false)
    let version = 1
    for (let index = 0; index < 15; index++) {
      const kind = index < 5 ? 'unchanged' : (index - 5) % 2 ? 'restore' : 'edit'
      const before = performance.now()
      if (kind !== 'unchanged') {
        version++
        send({ method: 'textDocument/didChange', params: { textDocument: { uri, version }, contentChanges: [{ text: kind === 'edit' ? errorText : original }] } })
      }
      const diagnostics = await pull()
      samples.push({ kind, durationMs: performance.now() - before, diagnostics }); verify(diagnostics, kind === 'edit')
    }
    const project = await request('custom/projectInfo', { textDocument: { uri } })
    if (project.configFilePath !== join(workspace, 'packages/about-view/tsconfig.json')) throw new Error(`Wrong project: ${JSON.stringify(project)}`)
    metadata = { initialize, project, executable: getExePath() }
    await request('shutdown', undefined); send({ method: 'exit' })
  } finally {
    fail(new Error('LSP benchmark disposed'))
    const stopped = new Promise<void>(done => child.once('exit', () => done()))
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await stopped }
    await mkdir(resolve(output, '..'), { recursive: true })
    await writeFile(output + '.stderr.log', log)
  }
}
await writeFile(output, JSON.stringify({ mode, metadata, samples }, null, 2) + '\n')
console.log(JSON.stringify({ mode, cold: samples[0], samples: samples.length }))
