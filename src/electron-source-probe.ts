import { readFile, writeFile, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const [binaryPath, resultPath] = process.argv.slice(2)
if (!binaryPath || !resultPath) throw new Error('Usage: node src/electron-source-probe.ts <official LVCE v0.120.23 Linux x64 binary> <result.json>')
const binary = resolve(binaryPath)
const data = await readFile(binary)
const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex')
if (sha256(data) !== 'ee9faf5bb9fe78a750cc5099863c85c4459e7f04c387fd1f111c83e4e8c57c97') throw new Error('Unexpected binary; refusing patch')
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
const embedded = execFileSync(binary, ['-e', 'process.stdout.write(process.binding("natives")["electron/js2c/node_init"])'], { env })
const offset = data.indexOf(embedded)
if (offset < 0 || data.indexOf(embedded, offset + 1) !== -1) throw new Error('Expected unique source bytes')
const patched = Buffer.from(data)
const probe = Buffer.from('process._electronSourceProbe=true;')
probe.copy(patched, offset)
patched.fill(32, offset + probe.length, offset + embedded.length)
const copy = `${binary}-source-probe`
await writeFile(copy, patched, { mode: 0o755, flag: 'wx' })
try {
  const rows = []
  for (const [variant, flags] of [['normal', []], ['no-lazy', ['--no-lazy']]] as const) {
    const observed = JSON.parse(execFileSync(copy, [...flags, '-e', 'console.log(JSON.stringify({sourceProbe:process._electronSourceProbe===true,appEntry:true}))'], { env, encoding: 'utf8', timeout: 10000 }))
    rows.push({ variant, flags, ...observed })
  }
  if (rows[0].sourceProbe !== false || rows[1].sourceProbe !== true) throw new Error('Unexpected cache behavior; do not reuse conclusions')
  await writeFile(resolve(resultPath), JSON.stringify({ binarySha256: sha256(data), probeBinarySha256: sha256(patched), offset, sourceBytes: embedded.length, rows,
    warning: 'This probe removes node_init behavior and is not a runnable application candidate or performance measurement',
  }, null, 2) + '\n')
} finally { await unlink(copy) }
