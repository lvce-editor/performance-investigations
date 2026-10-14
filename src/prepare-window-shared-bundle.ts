import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { bundleSharedGraph } from './bundle-shared-graph.ts'

const [baselineArgument, candidateArgument, evidenceArgument] = process.argv.slice(2)
if (!baselineArgument || !candidateArgument || !evidenceArgument) throw new Error('Expected baseline, candidate, evidence directories')
const baseline = resolve(baselineArgument), candidate = resolve(candidateArgument), evidence = resolve(evidenceArgument)
await mkdir(candidate, { recursive: false })
await cp(baseline, candidate, { recursive: true, preserveTimestamps: true })
const sharedRoot = join(candidate, 'usr/lib/lvce/resources/app/packages/shared-process')
const entry = join(sharedRoot, 'src/sharedProcessMain.js')
const originalEntry = await readFile(entry, 'utf8')
const metadata = await bundleSharedGraph(entry, join(sharedRoot, 'dist-startup'))
const hash = (source: string) => createHash('sha256').update(source).digest('hex')
const inputs = []
for (const [file, data] of Object.entries(metadata.inputs)) {
  inputs.push({ file, ...data, sha256: hash(await readFile(file, 'utf8')) })
}
const outputs = []
for (const [file, data] of Object.entries(metadata.outputs)) {
  outputs.push({ file, ...data, sha256: hash(await readFile(file, 'utf8')) })
}
if (!outputs.some(output => output.imports.some(item => item.kind === 'dynamic-import'))) throw new Error('Expected preserved dynamic imports')
// Keep the production main-process launch path. All local graph references now
// use the same split graph; no mix of original and bundled singleton modules.
await writeFile(entry, "import '../dist-startup/sharedProcessMain.js'\n")
await mkdir(evidence, { recursive: false })
await cp(join(sharedRoot, 'dist-startup'), join(evidence, 'bundle'), { recursive: true })
await writeFile(join(evidence, 'original-entry.js'), originalEntry)
await writeFile(join(evidence, 'provenance.json'), JSON.stringify({
  baseline, candidate, electronVersion: (await readFile(join(baseline, 'usr/lib/lvce/version'), 'utf8')).trim(),
  scope: 'Shared-process local ESM graph only; packages external, dynamic imports split, no minification or tree shaking, keepNames=true; original Root URL retained',
  inputs, outputs,
}, null, 2) + '\n')
console.log(JSON.stringify({ inputs: inputs.length, outputs: outputs.length, inputBytes: inputs.reduce((n, x) => n + x.bytes, 0), outputBytes: outputs.reduce((n, x) => n + x.bytes, 0) }))
