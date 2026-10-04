import { readdir, readFile, copyFile, cp, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const provenance: any[] = []
for (const variant of ['baseline', 'candidate']) {
  const staticRoot = resolve(`runtimes/${variant}/root/usr/lib/lvce/resources/app/static`)
  const destinations: string[] = []
  for (const entry of await readdir(staticRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const extension = join(staticRoot, entry.name, 'extensions/builtin.language-features-typescript')
    try { await readFile(join(extension, 'typescriptWorkerMain.js')); destinations.push(extension) }
    catch (error: any) { if (error.code !== 'ENOENT') throw error }
  }
  if (destinations.length !== 1) throw new Error(`Expected exactly one packaged TypeScript extension, got ${destinations.length}`)
  const destination = destinations[0]
  const source = resolve(`experiments/${variant}/.tmp/dist`)
  const worker = await readFile(join(source, 'typescriptWorkerMain.js'))
  const library = JSON.parse(await readFile(join(source, 'typescript/package.json'), 'utf8'))
  // Both variants use the same worker dependencies from their identical lockfiles.
  // The extension activation code and every other application asset stay fixed.
  await copyFile(join(source, 'typescriptWorkerMain.js'), join(destination, 'typescriptWorkerMain.js'))
  await cp(join(source, 'typescript'), join(destination, 'typescript'), { recursive: true })
  provenance.push({ variant, ref: process.env[variant.toUpperCase()], release: process.env.RELEASE, workerHash: hash(worker), typescriptVersion: library.version, lockfileHash: hash(await readFile(resolve(`experiments/${variant}/package-lock.json`))) })
}
if (provenance[0].lockfileHash !== provenance[1].lockfileHash) throw new Error('Extension lockfiles differ; comparison would not isolate the worker patch')
await mkdir('results', { recursive: true })
await writeFile('results/provenance.json', JSON.stringify(provenance, null, 2) + '\n')
console.log(provenance)
