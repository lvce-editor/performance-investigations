import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const capture = resolve('src/capture.ts')
test('captures an isolated child, validates the manifest, and writes timing summaries', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'lvce-capture-test-'))
  try {
    const executable = join(temporary, 'lvce')
    await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path')
const root = process.argv.at(-1); const directory = path.join(root, 'lvce-cpu-test')
fs.mkdirSync(directory)
fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ errors: [], trace: 'trace.json' }))
fs.writeFileSync(path.join(directory, 'trace.json'), JSON.stringify({ traceEvents: [
{ name: 'Profile', pid: 1, tid: 1, id: '1', ph: 'P', ts: 1000, args: { data: { startTime: 1000 } } },
{ name: 'ProfileChunk', pid: 1, tid: 2, id: '1', ph: 'P', ts: 3000, args: { data: { cpuProfile: { nodes: [{id: 1, callFrame: {functionName: '(root)'}}, {id: 2, parent: 1, callFrame: {functionName: 'work'}}], samples: [2,2] }, timeDeltas: [1000,1000] } } }
] }))
fs.writeFileSync(path.join(root, 'observed.json'), JSON.stringify({ home: process.env.HOME, xdg: process.env.XDG_CONFIG_HOME, args: process.argv.slice(2) }))
`, { mode: 0o700 })
    const workspace = join(temporary, 'workspace'); await mkdir(workspace)
    const output = join(temporary, 'result')
    const result = spawnSync(process.execPath, [capture, executable, workspace, 'file.ts', output], { encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 0, result.stderr)
    const observed = JSON.parse(await readFile(join(output, 'observed.json'), 'utf8'))
    assert.equal(observed.home, process.env.HOME)
    assert.equal(observed.xdg, join(output, 'runtime', 'config'))
    assert.ok(observed.args.includes('--cpu-profile'))
    const summary = JSON.parse(await readFile(join(output, 'summary.json'), 'utf8'))
    assert.equal(summary.profiles.length, 1)
    assert.equal(summary.profiles[0].nonIdleMs, 1)
    const metadata = JSON.parse(await readFile(join(output, 'capture.json'), 'utf8'))
    assert.equal(metadata.exitCode, 0)
    assert.equal(metadata.timedOut, false)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('a timed out child fails capture and preserves failure metadata', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'lvce-capture-timeout-'))
  try {
    const executable = join(temporary, 'lvce')
    await writeFile(executable, '#!/usr/bin/env node\nsetInterval(() => {}, 1000)\n', { mode: 0o700 })
    const output = join(temporary, 'result')
    const result = spawnSync(process.execPath, [capture, executable, temporary, 'file.ts', output, '100'], { encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /timed out/)
    assert.equal(JSON.parse(await readFile(join(output, 'capture.json'), 'utf8')).timedOut, true)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
