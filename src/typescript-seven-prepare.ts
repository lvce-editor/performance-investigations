import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'

const [checkoutArg, outputArg] = process.argv.slice(2)
if (!outputArg) throw new Error('Usage: typescript-seven-prepare.ts <extension> <output-dir>')
const checkout = resolve(checkoutArg), output = resolve(outputArg)
const path = join(checkout, 'packages/extension/src/parts/Activate/Activate.ts')
const original = await readFile(path, 'utf8')
const anchor = '  RegisterProviders.registerProviders(Object.values(Providers))'
if (!original.includes(anchor) || original.includes('benchmarkDiagnostics')) throw new Error('Unexpected activation source')
const source = "import * as BenchmarkRpc from '../Rpc/Rpc.ts'\n" + original.replace(anchor, `  registerCommand({ id: 'typescript.benchmarkDiagnostics', execute: (document: any) => BenchmarkRpc.invoke('Diagnostic.getPerformanceTrace', document) })
  registerCommand({ id: 'typescript.benchmarkCompletion', execute: (document: any, offset: number) => BenchmarkRpc.invoke('Completion.getCompletions', document, offset) })
  registerCommand({ id: 'typescript.benchmarkReferences', execute: (document: any, offset: number) => BenchmarkRpc.invoke('References.provideReferences', document, offset) })
${anchor}`)
const manifestPath = join(checkout, 'packages/extension/extension.json')
const manifestOriginal = await readFile(manifestPath, 'utf8')
const manifest = JSON.parse(manifestOriginal)
for (const feature of ['Diagnostics', 'Completion', 'References']) {
  const id = 'typescript.benchmark' + feature
  manifest.activation.push('onCommand:' + id)
  manifest.commands.push({ id, label: 'Benchmark ' + feature })
}
await writeFile(path, source)
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
await mkdir(output, { recursive: true })
await writeFile(join(output, 'activation.original.ts'), original)
await writeFile(join(output, 'activation.instrumented.ts'), source)
await writeFile(join(output, 'manifest.original.json'), manifestOriginal)
await writeFile(join(output, 'manifest.instrumented.json'), JSON.stringify(manifest, null, 2) + '\n')
await writeFile(join(output, 'instrumentation.json'), JSON.stringify({
  originalHash: createHash('sha256').update(original).digest('hex'),
  instrumentedHash: createHash('sha256').update(source).digest('hex'),
  note: 'Harness-only commands forward directly to existing worker entry points. Diagnostics avoid opening a performance-report editor. Production compiler, resolver and filesystem logic are unchanged.',
}, null, 2) + '\n')
