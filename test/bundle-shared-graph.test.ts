import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { bundleSharedGraph } from '../src/bundle-shared-graph.ts'

test('split graph preserves lazy execution, module singletons, function names and original root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-graph-'))
  try {
    const src = join(root, 'src'), dist = join(root, 'dist-startup')
    await mkdir(join(src, 'parts/Root'), { recursive: true })
    await writeFile(join(root, 'package.json'), '{"type":"module"}')
    await writeFile(join(src, 'state.js'), 'export const state = { value: 0 }; export const load = () => state.value;')
    await writeFile(join(src, 'lazy.js'), 'import { state } from "./state.js"; export { rootUrl } from "./parts/Root/Root.js"; state.value++; export const load = () => state.value;')
    await writeFile(join(src, 'parts/Root/Root.js'), 'export const rootUrl = import.meta.url;')
    await writeFile(join(src, 'main.js'), `import { state, load } from './state.js'; import { rootUrl } from './parts/Root/Root.js';
      const before = state.value; const lazy = await import('./lazy.js');
      if (lazy.rootUrl !== rootUrl) throw new Error('Root singleton path mismatch');
      console.log(JSON.stringify({ before, after: state.value, value: lazy.load(), names: [load.name, lazy.load.name], rootUrl }));`)
    const metadata = await bundleSharedGraph(join(src, 'main.js'), dist)
    assert.ok(Object.values(metadata.outputs).some(output => output.imports.some(item => item.kind === 'dynamic-import')))
    const result = JSON.parse(execFileSync(process.execPath, [join(dist, 'main.js')], { encoding: 'utf8' }))
    assert.deepEqual(result, { before: 0, after: 1, value: 1, names: ['load', 'load'], rootUrl: new URL(`file://${join(src, 'parts/Root/Root.js')}`).href })
  } finally { await rm(root, { recursive: true, force: true }) }
})
