import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { summarizeComparison } from '../src/summarize-typescript-comparison.ts'

const fixtures = () => ({
  node: { repeats: 1, modes: {}, comparison: { loadedFilesEqual: true }, results: [{ mode: 'lvce', options: { rootDir: 'file:///workspace/packages/about-view' }, loadedFiles: [{ path: 'packages/about-view/src/main.ts', bytes: 100 }, { path: 'typescript/lib/lib.es5.d.ts', bytes: 200 }] }] },
  browser: { repeats: 1, rows: ['cold', 'warm'].map(mode => ({ mode, iteration: 0, trace: { totalDurationMs: mode === 'cold' ? 10 : 1, syncRpc: { durationMs: mode === 'cold' ? 8 : 0, callCount: mode === 'cold' ? 2 : 0, methods: { exists: { callCount: 2, durationMs: 8 } } }, loadedFiles: [{ fileName: 'file:///workspace/packages/about-view/src/main.ts', sizeBytes: 100 }, { fileName: 'lib.es5.d.ts', sizeBytes: 200 }] } })) },
})

test('browser and Node graphs normalize file URIs and bundled library paths', () => {
  const { node, browser } = fixtures()
  const result = summarizeComparison(node, browser)
  assert.equal(result.graphValidation.browserPathsAndSizesEqual, true)
  assert.equal(result.graphValidation.bytes, 300)
  assert.equal(result.browser.remainingMs, 2)
  assert.equal(result.browser.warmRpcCalls, 0)
})

test('a browser loading different declaration content invalidates the comparison', () => {
  const { node, browser } = fixtures()
  browser.rows[0].trace.loadedFiles[1].sizeBytes++
  assert.throws(() => summarizeComparison(node, browser), /Browser source graph differs/)
})
