import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reconstruct, summarize, type Profile } from '../src/profiles.ts'

const fixture = (): Profile => ({
  startTime: 1000, endTime: 6000,
  nodes: [
    { id: 1, callFrame: { functionName: '(root)' }, children: [2, 4] },
    { id: 2, callFrame: { functionName: 'outer', url: 'x.js' }, children: [3] },
    { id: 3, callFrame: { functionName: 'inner', url: 'x.js' } },
    { id: 4, callFrame: { functionName: '(idle)' } },
  ], samples: [3, 2, 4], timeDeltas: [1000, 1000, 2000],
})
test('self and inclusive time use following intervals, omit pre-sample gap', () => {
  const summary = summarize(fixture())
  assert.equal(summary.observedMs, 4)
  assert.equal(summary.nonIdleMs, 3)
  assert.equal(summary.topSelf.find((r) => r.name.startsWith('inner'))?.ms, 1)
  assert.equal(summary.topInclusive.find((r) => r.name.startsWith('outer'))?.ms, 3)
})
test('negative deltas reorder timestamps without inflating or shifting time', () => {
  const profile = fixture()
  profile.samples = [2, 3, 4]
  profile.timeDeltas = [2000, -1000, 3000]
  const summary = summarize(profile)
  assert.equal(summary.negativeDeltas, 1)
  assert.equal(summary.observedMs, 4)
  assert.equal(summary.nonIdleMs, 3)
  assert.equal(summary.topSelf.find((r) => r.name.startsWith('inner'))?.ms, 1)
})
test('global startup window clips samples and excludes late workers', () => {
  assert.equal(summarize(fixture(), 0, 4).nonIdleMs, 2)
  assert.equal(summarize(fixture(), 0, 0.5).observedMs, 0)
})
test('rejects mismatched samples, unknown ids, and cycles', () => {
  assert.throws(() => summarize({ ...fixture(), samples: [3] }), /length mismatch/)
  assert.throws(() => summarize({ ...fixture(), samples: [99, 2, 4] }), /Unknown sampled/)
  const profile = fixture()
  profile.nodes[0].parent = 3
  assert.throws(() => summarize(profile), /Cycle/)
})
test('reconstructs ProfileChunks using pid and id, retains start thread, deduplicates overlapping profilers', () => {
  const start = (pid: number, id: string) => ({ name: 'Profile', pid, tid: 10, ts: 1000, ph: 'P', id, args: { data: { startTime: 1000 } } })
  const chunk = (pid: number, id: string, samples: number[]) => ({ name: 'ProfileChunk', pid, tid: 99, ts: 2000, ph: 'P', id, args: { data: { cpuProfile: { nodes: fixture().nodes, samples }, timeDeltas: samples.map(() => 1000) } } })
  const result = reconstruct([start(1, 'a'), chunk(1, 'a', [2]), start(1, 'b'), chunk(1, 'b', [2, 3]), start(2, 'a'), chunk(2, 'a', [4])])
  assert.equal(result.profiles.length, 2)
  assert.deepEqual(result.excluded, ['1:a'])
  assert.equal(result.profiles[0].tid, 10)
})
test('recursive frames are counted once per sample in inclusive rows', () => {
  const profile = fixture()
  profile.nodes[2].callFrame = profile.nodes[1].callFrame
  assert.equal(summarize(profile).topInclusive.find((r) => r.name.startsWith('outer'))?.ms, 3)
})

test('normalizes localhost ports, build ids and variant checkout paths for comparisons', async () => {
  const { cleanUrl } = await import('../src/profiles.ts')
  assert.equal(cleanUrl('http://localhost:1234/abcdef/packages/editor-worker/dist/editorWorkerMain.js'), '<app>/packages/editor-worker/dist/editorWorkerMain.js')
  assert.equal(cleanUrl('http://localhost:5678/remote/home/runner/work/performance/experiments/baseline/packages/extension/dist/eslintMain.js'), '<app>/extensions/builtin.eslint/dist/eslintMain.js')
  assert.equal(cleanUrl('lvce://-/abc/packages/editor-worker/dist/editorWorkerMain.js?config=private'), '<app>/packages/editor-worker/dist/editorWorkerMain.js')
})

test('separates distinct minified functions on the same source line', () => {
  const profile = fixture()
  profile.nodes[1].callFrame = { functionName: 'm', url: 'bundle.js', lineNumber: 0, columnNumber: 10 }
  profile.nodes[2].callFrame = { functionName: 'm', url: 'bundle.js', lineNumber: 0, columnNumber: 200 }
  const summary = summarize(profile)
  const functions = summary.topInclusive.filter((row) => row.name.startsWith('m @ '))
  assert.equal(functions.length, 2)
  assert.equal(functions.find((row) => row.name.endsWith(':1:11'))?.ms, 3)
  assert.equal(functions.find((row) => row.name.endsWith(':1:201'))?.ms, 1)
})
