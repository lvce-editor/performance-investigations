import { readFile, writeFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const median = (values: number[]) => {
  const sorted = values.toSorted((a,b) => a-b), mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid-1] + sorted[mid]) / 2
}

export const summarizeComparison = (node: any, browser: any) => {
  const lvce = node.results.find((row: any) => row.mode === 'lvce')
  const directory = lvce.options.rootDir.startsWith('file:') ? fileURLToPath(lvce.options.rootDir) : lvce.options.rootDir
  const workspace = resolve(directory, '../..')
  const expected = lvce.loadedFiles.map(({ path, bytes }: any) => ({ path, bytes }))
  for (const row of browser.rows) {
    const actual = row.trace.loadedFiles.map((file: any) => ({
      path: file.fileName.startsWith('lib.') && !file.fileName.includes('/') ? `typescript/lib/${file.fileName}` : relative(workspace, file.fileName.startsWith('file:') ? fileURLToPath(file.fileName) : file.fileName),
      bytes: file.sizeBytes,
    })).sort((a: any,b: any) => a.path.localeCompare(b.path))
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Browser source graph differs in ${row.mode} iteration ${row.iteration}`)
  }
  const cold = browser.rows.filter((row: any) => row.mode === 'cold').map((row: any) => row.trace)
  const warm = browser.rows.filter((row: any) => row.mode === 'warm').map((row: any) => row.trace)
  const methods = Object.fromEntries(Object.keys(cold[0].syncRpc.methods).map(name => [name, {
    calls: median(cold.map((trace: any) => trace.syncRpc.methods[name].callCount)),
    durationMs: median(cold.map((trace: any) => trace.syncRpc.methods[name].durationMs)),
  }]))
  return {
    schemaVersion: 1, nodeVersion: node.nodeVersion, typescriptVersion: node.typescriptVersion,
    extensionCommit: node.extensionCommit, workspaceCommit: node.workspaceCommit,
    nodeRepeats: node.repeats, browserRepeats: browser.repeats,
    graphValidation: { nodeContentHashesEqual: node.comparison.loadedFilesEqual, browserPathsAndSizesEqual: true, loadedFiles: expected.length, bytes: expected.reduce((sum: number, file: any) => sum + file.bytes, 0) },
    node: node.modes,
    browser: {
      diagnosticRequestMs: median(cold.map((trace: any) => trace.totalDurationMs)),
      syncRpcMs: median(cold.map((trace: any) => trace.syncRpc.durationMs)),
      remainingMs: median(cold.map((trace: any) => trace.totalDurationMs - trace.syncRpc.durationMs)),
      methods,
      warmDiagnosticRequestMs: median(warm.map((trace: any) => trace.totalDurationMs)),
      warmRpcCalls: median(warm.map((trace: any) => trace.syncRpc.callCount)),
      coldDurationsMs: cold.map((trace: any) => trace.totalDurationMs),
    },
    note: 'Medians from separate unprofiled runs on one runner; compiler measures overlap. CLI checks every project file/declaration, hosts check one opened file. Node request timers exclude module startup; processElapsedMs includes it. Browser worker timer excludes activation and UI rendering. Remaining browser time includes libraries, parsing, binding, checking, and trace collection; it is not isolated compiler CPU. Warm requests reuse unchanged text and are not edit latency.',
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [nodePath, browserPath, output] = process.argv.slice(2)
  if (!output) throw new Error('Usage: summarize-typescript-comparison.ts <node-overview.json> <browser-overview.json> <output.json>')
  const summary = summarizeComparison(JSON.parse(await readFile(nodePath, 'utf8')), JSON.parse(await readFile(browserPath, 'utf8')))
  await writeFile(output, JSON.stringify(summary, null, 2) + '\n')
  console.log(summary.browser)
}
