import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { deepStrictEqual } from 'node:assert'
import { transform, version as esbuildVersion } from 'esbuild'
import { parseAst } from 'rollup/parseAst'

const [baselineArgument, candidateArgument, outputArgument] = process.argv.slice(2)
if (!baselineArgument || !candidateArgument || !outputArgument) throw new Error('Usage: node src/prepare-window-whitespace.ts <extracted deb root> <new candidate directory> <new evidence directory>')
const baseline = resolve(baselineArgument), candidate = resolve(candidateArgument), output = resolve(outputArgument)
const staticRoot = join(baseline, 'usr/lib/lvce/resources/app/static')
const revisions = (await readdir(staticRoot, { withFileTypes: true })).filter(entry => entry.isDirectory())
const files: string[] = []
for (const revision of revisions) {
  const file = join('usr/lib/lvce/resources/app/static', revision.name, 'packages/renderer-worker/dist/rendererWorkerMain.js')
  try { await readFile(join(baseline, file)); files.push(file) } catch (error: any) { if (error.code !== 'ENOENT') throw error }
}
if (files.length !== 1) throw new Error('Expected exactly one packaged renderer worker')
const file = files[0], original = await readFile(join(baseline, file), 'utf8')
const options = { minifyWhitespace: true, minifyIdentifiers: false, minifySyntax: false, legalComments: 'inline' as const, target: 'esnext' }
const compact = (await transform(original, options)).code
// Independently parse both complete programs. Ignore only source-location and
// literal spelling metadata; retain every identifier, value and AST operation.
const semanticAst = (source: string) => JSON.parse(JSON.stringify(parseAst(source), (key, value) =>
  ['start', 'end', 'raw', '_rollupAnnotations'].includes(key) ? undefined : value))
deepStrictEqual(semanticAst(compact), semanticAst(original))
if (Buffer.byteLength(compact) >= Buffer.byteLength(original)) throw new Error('Whitespace candidate is not smaller')
await mkdir(candidate, { recursive: false })
await cp(baseline, candidate, { recursive: true, preserveTimestamps: true })
await writeFile(join(candidate, file), compact)
await mkdir(output, { recursive: false })
await writeFile(join(output, 'original-renderer-worker.js'), original)
await writeFile(join(output, 'compact-renderer-worker.js'), compact)
const hash = (source: string) => createHash('sha256').update(source).digest('hex')
const evidence = {
  baseline, candidate, file, esbuildVersion, options,
  electronVersion: (await readFile(join(baseline, 'usr/lib/lvce/version'), 'utf8')).trim(),
  originalBytes: Buffer.byteLength(original), compactBytes: Buffer.byteLength(compact),
  originalSha256: hash(original), compactSha256: hash(compact),
  semanticAstSha256: hash(JSON.stringify(semanticAst(original))), semanticAstEqual: true,
  scope: 'Only renderer-worker whitespace/comments; identifiers, syntax, function names and execution order preserved',
}
await writeFile(join(output, 'provenance.json'), JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify(evidence))
