import { strict as assert } from 'node:assert'
import { CompilerPathMap } from './compiler-path-map.ts'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const probeUris = (ts: any) => {
  const roots = ['file:///workspace', 'file:///C:/workspace', 'file://server/share/workspace', 'html://site/workspace', 'memfs:///workspace', 'memfs://other/workspace']
  const rows: any[] = []
  for (const root of roots) {
    for (const representation of ['uri', 'mapped']) {
    const map = new CompilerPathMap()
    const encode = (uri: string) => representation === 'mapped' ? map.toCompiler(uri) : uri
    const compilerRoot = encode(root)
    let ancestor = compilerRoot
    while (ts.getDirectoryPath(ancestor) !== ancestor) ancestor = ts.getDirectoryPath(ancestor)
    assert.equal(ancestor, representation === 'mapped' ? compilerRoot.slice(0, compilerRoot.indexOf('/', 2) + 1) : root.slice(0, ts.getRootLength(root)))
    const files = new Map<string, string>([
      [`${root}/package.json`, JSON.stringify({ type: 'module' })],
      [`${root}/src/plain.ts`, 'export const value = 1'],
      [`${root}/src/space%20name.ts`, 'export const value = 1'],
      [`${root}/src/hash%23name.ts`, 'export const value = 1'],
      [`${root}/src/percent%25name.ts`, 'export const value = 1'],
      [`${root}/node_modules/pkg/package.json`, JSON.stringify({ types: 'index.d.ts' })],
      [`${root}/node_modules/pkg/index.d.ts`, 'export declare const value: number'],
      [`${root}/node_modules/exported/package.json`, JSON.stringify({ name: 'exported', type: 'module', exports: { '.': { types: './index.d.ts' } } })],
      [`${root}/node_modules/exported/index.d.ts`, 'export declare const value: number'],
    ])
    const compilerFiles = new Map([...files].map(([uri, text]) => [encode(uri), text]))
    const calls: { method: string; path: string }[] = []
    const host = {
      fileExists(path: string) { calls.push({ method: 'fileExists', path }); return compilerFiles.has(path) },
      directoryExists(path: string) { calls.push({ method: 'directoryExists', path }); return [...compilerFiles.keys()].some(file => file.startsWith(path.replace(/\/$/, '') + '/')) },
      readFile(path: string) { calls.push({ method: 'readFile', path }); return compilerFiles.get(path) },
      realpath: (path: string) => path,
      getCurrentDirectory: () => compilerRoot,
    }
    for (const specifier of ['./plain.js', './space name.js', './space%20name.js', './hash#name.js', './hash%23name.js', './percent%name.js', './percent%25name.js', 'pkg', 'exported', `${root}/src/plain.ts`]) {
      calls.length = 0
      const result = ts.resolveModuleName(specifier, encode(`${root}/src/main.ts`), { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, allowImportingTsExtensions: true }, host, undefined, undefined, ts.ModuleKind.ESNext)
      const resolved = result.resolvedModule?.resolvedFileName
      const resource = resolved && (representation === 'mapped' ? map.toUri(resolved) : resolved)
      const ordinary = ['./plain.js', 'pkg', 'exported'].includes(specifier)
      const rawSpecial = ['./space name.js', './hash#name.js', './percent%name.js'].includes(specifier)
      if (ordinary || (representation === 'mapped' && rawSpecial)) assert.ok(resource, `${representation}: ${root}: ${specifier}`)
      if (representation === 'uri' && rawSpecial) assert.equal(resource, undefined)
      if (specifier === `${root}/src/plain.ts`) assert.equal(resource, undefined)
      rows.push({ representation, root, specifier, resolved: resource ?? null, calls: [...calls] })
    }
  }
  }
  return { typescriptVersion: ts.version, rows }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [checkout, output] = process.argv.slice(2)
  if (!output) throw new Error('Usage: typescript-uri-probes.ts <checkout-with-typescript> <output.json>')
  const require = createRequire(resolve(checkout, 'package.json'))
  const result = probeUris(require('typescript'))
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
  console.log(result.rows.map(row => ({ root: row.root, specifier: row.specifier, resolved: row.resolved })))
}
