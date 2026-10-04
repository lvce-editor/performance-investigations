import { readdir, readFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { brotliDecompressSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'

const provenance: any[] = []
for (const variant of ['baseline', 'candidate']) {
  const staticRoot = resolve(`runtimes/${variant}/root/usr/lib/lvce/resources/app/static`)
  for (const [name, repository] of [['eslint', 'eslint'], ['typescript', 'language-features-typescript']]) {
    const tag = process.env[`${variant.toUpperCase()}_${name.toUpperCase()}`]!
    if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`Invalid extension release tag: ${tag}`)
    const source = resolve(`downloads/${variant}/${name}`)
    const metadata = JSON.parse(await readFile(join(source, 'release.json'), 'utf8'))
    if (metadata.isDraft || metadata.tagName !== tag) throw new Error('Expected a published matching release')
    const assetName = `${repository}-${tag}.tar.br`
    const asset = metadata.assets.find((item: any) => item.name === assetName)
    if (!asset) throw new Error(`Missing exact release archive: ${assetName}`)
    const bytes = await readFile(join(source, assetName))
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    if (asset.digest && asset.digest !== digest) throw new Error(`Release archive digest mismatch: ${assetName}`)
    const candidates: string[] = []
    for (const entry of await readdir(staticRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const extension = join(staticRoot, entry.name, `extensions/builtin.${repository}`)
      try { await readFile(join(extension, 'extension.json')); candidates.push(extension) }
      catch (error: any) { if (error.code !== 'ENOENT') throw error }
    }
    if (candidates.length !== 1) throw new Error('Expected exactly one runtime extension destination')
    const destination = candidates[0]
    const archive = join(source, 'extension.tar')
    await writeFile(archive, brotliDecompressSync(bytes))
    await rm(destination, { recursive: true })
    await mkdir(destination)
    execFileSync('tar', ['-xf', archive, '-C', destination])
    const manifest = JSON.parse(await readFile(join(destination, 'extension.json'), 'utf8'))
    if (manifest.id !== `builtin.${repository}`) throw new Error('Unexpected extension identity')
    provenance.push({ variant, repository: `lvce-editor/${repository}`, tag, runtime: process.env.RELEASE, assetName, digest, publishedAt: metadata.publishedAt })
  }
}
await mkdir('results', { recursive: true })
await writeFile('results/provenance.json', JSON.stringify(provenance, null, 2) + '\n')
console.log(provenance)
