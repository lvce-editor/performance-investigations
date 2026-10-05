import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { CompilerPathMap } from '../src/compiler-path-map.ts'

test('schemes and authorities remain separate compiler mounts', () => {
  const map = new CompilerPathMap()
  const uris = ['file:///workspace/main.ts', 'html://site/workspace/main.ts', 'memfs:///workspace/main.ts', 'memfs://other/workspace/main.ts', 'remote-ssh://alice@host/workspace/main.ts', 'remote-ssh://bob@host/workspace/main.ts']
  const paths = uris.map(uri => map.toCompiler(uri))
  assert.equal(new Set(paths).size, uris.length)
  paths.forEach((path,index) => assert.equal(map.toUri(path), uris[index]))
})

test('literal spaces, percent, hashes, question marks and Unicode survive round trips', () => {
  const map = new CompilerPathMap()
  const uri = 'memfs:///workspace/a%20%25%23%3F%C3%A9.ts'
  const path = map.toCompiler(uri)
  assert.ok(path.endsWith('/workspace/a %#?é.ts'))
  assert.equal(map.toUri(path), uri)
  assert.equal(map.toUri(path.replace('é.ts', 'b.ts')), 'memfs:///workspace/a%20%25%23%3Fb.ts')
})

test('Windows volumes are separate roots and UNC authorities retain their identity', () => {
  const map = new CompilerPathMap()
  const c = map.toCompiler('file:///C:/workspace/a.ts')
  const d = map.toCompiler('file:///D:/workspace/a.ts')
  const unc = map.toCompiler('file://server/share/a.ts')
  assert.notEqual(c.split('/')[2], d.split('/')[2])
  assert.equal(map.toUri(c.replace('a.ts', 'b.ts')), 'file:///C:/workspace/b.ts')
  assert.equal(map.toUri(unc), 'file://server/share/a.ts')
})

test('unknown mounts, encoded separators and unspecified query identities fail explicitly', () => {
  const map = new CompilerPathMap()
  assert.throws(() => map.toUri('/file/workspace/a.ts'), /Outside/)
  assert.throws(() => map.toCompiler('memfs:///a%2Fb.ts'), /separators/)
  assert.throws(() => map.toCompiler('html://site/a.ts?version=1'), /query/)
  assert.throws(() => map.toCompiler('html://site/a.ts#fragment'), /query/)
})


test('encoded percent spelling does not alias a different literal filename', () => {
  const map = new CompilerPathMap()
  const space = map.toCompiler('memfs:///workspace/name%20file.ts')
  const percent = map.toCompiler('memfs:///workspace/name%2520file.ts')
  assert.notEqual(space, percent)
  assert.ok(space.endsWith('/name file.ts'))
  assert.ok(percent.endsWith('/name%20file.ts'))
  assert.equal(map.toUri(percent.replace('.ts', '.js')), 'memfs:///workspace/name%2520file.js')
})
