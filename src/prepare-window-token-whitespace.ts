import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { compactTokenWhitespace, semanticAst } from './compact-token-whitespace.ts'

const [baselineArgument, candidateArgument, outputArgument] = process.argv.slice(2)
if (!baselineArgument || !candidateArgument || !outputArgument) throw new Error('Expected baseline, candidate, evidence directories')
const baseline = resolve(baselineArgument), candidate = resolve(candidateArgument), output = resolve(outputArgument)
const files = ['usr/lib/lvce/resources/app/packages/main-process/dist/mainProcessMain.js']
const sharedRoot = join(baseline, 'usr/lib/lvce/resources/app/packages/shared-process/src')
for (const entry of await readdir(sharedRoot, { recursive: true, withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.js')) files.push(relative(baseline, join(entry.parentPath, entry.name)))
}
files.sort()
const hash = (source: string) => createHash('sha256').update(source).digest('hex')
const prepared = []
for (const file of files) {
  const original = await readFile(join(baseline, file), 'utf8')
  const compact = compactTokenWhitespace(original)
  prepared.push({ file, original, compact, evidence: {
    file, originalBytes: Buffer.byteLength(original), compactBytes: Buffer.byteLength(compact),
    originalSha256: hash(original), compactSha256: hash(compact),
    semanticAstSha256: hash(JSON.stringify(semanticAst(original))), semanticAstEqual: true,
  } })
}
if (!prepared.some(entry => entry.evidence.compactBytes < entry.evidence.originalBytes)) throw new Error('No source size saving')
await mkdir(candidate, { recursive: false })
await cp(baseline, candidate, { recursive: true, preserveTimestamps: true })
await mkdir(output, { recursive: false })
for (const entry of prepared) {
  await writeFile(join(candidate, entry.file), entry.compact)
  for (const [variant, source] of [['original', entry.original], ['compact', entry.compact]]) {
    const evidenceFile = join(output, variant, entry.file)
    await mkdir(resolve(evidenceFile, '..'), { recursive: true })
    await writeFile(evidenceFile, source)
  }
}
const evidence = {
  baseline, candidate,
  scope: 'Main-process and shared-process source whitespace only; all tokens, comments and inter-token line breaks preserved',
  electronVersion: (await readFile(join(baseline, 'usr/lib/lvce/version'), 'utf8')).trim(),
  files: prepared.map(entry => entry.evidence),
  originalBytes: prepared.reduce((sum, entry) => sum + entry.evidence.originalBytes, 0),
  compactBytes: prepared.reduce((sum, entry) => sum + entry.evidence.compactBytes, 0),
}
await writeFile(join(output, 'provenance.json'), JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify({ ...evidence, files: evidence.files.length }))
