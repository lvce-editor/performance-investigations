import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { builtinModules } from 'node:module'
import { rollup } from 'rollup'
import commonjs from '@rollup/plugin-commonjs'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import terser from '@rollup/plugin-terser'
import ts from 'typescript'

// Fixed-size substitution is experimental, Linux x64 only, and never edits the input.
const [sourceDir, binaryPath, outputDir] = process.argv.slice(2)
if (!sourceDir || !binaryPath || !outputDir) throw new Error('Usage: node src/electron-rollup.ts <Electron v44.4.5 source> <LVCE binary> <new output directory>')
const source = resolve(sourceDir), binary = resolve(binaryPath), output = resolve(outputDir)
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim()
if (sourceCommit !== '694f45852a0f1726cd23bfd379854de489cccb65') throw new Error('Expected Electron v44.4.5 source commit')
if (execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8' }).trim()) throw new Error('Electron source must be clean')
const original = await readFile(binary)
if (sha256(original) !== 'ee9faf5bb9fe78a750cc5099863c85c4459e7f04c387fd1f111c83e4e8c57c97') throw new Error('Expected official LVCE v0.120.23 Linux x64 executable')
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
const webpackSource = execFileSync(binary, ['-e', 'process.stdout.write(process.binding("natives")["electron/js2c/node_init"])'], { env })
const offset = original.indexOf(webpackSource)
if (offset < 0 || original.indexOf(webpackSource, offset + 1) !== -1) throw new Error('Expected exactly one embedded node_init source')
await mkdir(output, { recursive: false })
const inputs: Record<string, string> = {}
for (const name of ['init', 'asar-fs-wrapper']) {
  const file = join(source, 'lib/node', `${name}.ts`)
  const text = await readFile(file, 'utf8')
  inputs[`lib/node/${name}.ts`] = sha256(text)
  // Electron's special require bypasses webpack and receives native Node internal require.
  const transformed = ts.transpileModule(text.replaceAll('__non_webpack_require__', 'require'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, fileName: file,
  }).outputText
  await writeFile(join(output, `${name}.js`), transformed)
}
const graph = await rollup({
  input: join(output, 'init.js'), treeshake: false,
  external: (id) => builtinModules.includes(id) || id.startsWith('node:') || id.startsWith('internal/'),
  plugins: [nodeResolve(), commonjs({ strictRequires: true }), terser({ keep_classnames: true, keep_fnames: true })],
  onwarn(warning) { throw new Error(warning.message) },
})
let bundled: string
try {
  const result = await graph.generate({ format: 'cjs' })
  if (result.output.length !== 1 || result.output[0].type !== 'chunk') throw new Error('Expected one JS chunk')
  bundled = result.output[0].code
} finally { await graph.close() }
// The native function has process/require parameters, not CJS module/exports.
// Rollup's output is wrapped in a local CJS scope; native require remains lexical.
await writeFile(join(output, "raw-rollup.js"), bundled)
const candidate = `process._electronRollupProbe="node_init-v44.4.5";(()=>{const module={exports:{}};const exports=module.exports;${bundled}})();`
const candidateBytes = Buffer.from(candidate)
await writeFile(join(output, 'node-init-rollup.js'), candidate)
await writeFile(join(output, 'node-init-webpack.js'), webpackSource)
// Fail closed on oversized candidates; do not truncate or relocate native data.
let candidatePath: string | null = null
let candidateSha256: string | null = null
if (candidateBytes.length <= webpackSource.length) {
  const patched = Buffer.from(original)
  candidateBytes.copy(patched, offset)
  patched.fill(32, offset + candidateBytes.length, offset + webpackSource.length)
  candidatePath = `${binary}-rollup`
  await writeFile(candidatePath, patched, { mode: 0o755, flag: 'wx' })
  candidateSha256 = sha256(patched)
}
await writeFile(join(output, 'provenance.json'), JSON.stringify({
  sourceCommit, electronVersion: '44.4.5', lvceVersion: '0.120.23', platform: 'linux', arch: 'x64',
  binary, candidatePath, binarySha256: sha256(original), candidateSha256,
  sourceInputs: inputs, webpackSha256: sha256(webpackSource), rollupSha256: sha256(candidateBytes),
  webpackBytes: webpackSource.length, rollupBytes: candidateBytes.length, offset,
  substitution: candidatePath ? 'fits-fixed-source-slot' : 'blocked-oversized-source',
  paddedBytes: webpackSource.length, codeCache: 'Unchanged embedded cache; --no-lazy required and execution marker must be checked',
  scope: 'node_init only, used by ELECTRON_RUN_AS_NODE; browser_init and all other bundles unchanged',
}, null, 2) + '\n')
console.log(join(output, 'provenance.json'))
