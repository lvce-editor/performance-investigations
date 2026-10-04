import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
const [workspace, relativeFile, output] = process.argv.slice(2)
if (!workspace || !relativeFile || !output) throw new Error('Usage: node src/native-eslint-benchmark.ts <workspace> <relative-file> <output.json>')
const cwd = resolve(workspace)
const require = createRequire(join(cwd, 'package.json'))
const started = performance.now()
const { ESLint } = require('eslint')
const importMs = performance.now() - started
const eslint = new ESLint({ cwd })
const filePath = resolve(cwd, relativeFile)
const results = await eslint.lintText(await readFile(filePath, 'utf8'), { filePath })
const durationMs = performance.now() - started
await writeFile(output, JSON.stringify({
  durationMs, importMs, version: ESLint.version,
  results: results.map(({ messages, errorCount, warningCount }: any) => ({ messages, errorCount, warningCount })),
  note: 'Architecture experiment only: native Node filesystem and module loading, no browser sandbox or IPC. Not an equivalent production path or startup measurement.',
}, null, 2) + '\n')
console.log({ durationMs, importMs, results: results.map((r: any) => ({ errors: r.errorCount, warnings: r.warningCount })) })
