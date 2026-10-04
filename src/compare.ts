import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
const [baseline, candidate, output] = process.argv.slice(2)
if (!baseline || !candidate || !output) throw new Error('Usage: npm run compare -- <baseline-summary> <candidate-summary> <comparison.json>')
const a = JSON.parse(await readFile(resolve(baseline), 'utf8'))
const b = JSON.parse(await readFile(resolve(candidate), 'utf8'))
if (a.schemaVersion !== b.schemaVersion || a.windowMs !== b.windowMs) throw new Error('Incompatible summary schemas/windows')
const group = (summary: any) => {
  const result = new Map<string, number>()
  for (const profile of summary.profiles) result.set(profile.role, (result.get(profile.role) ?? 0) + profile.nonIdleMs)
  return result
}
const left = group(a), right = group(b)
const profiles = [...new Set([...left.keys(), ...right.keys()])].map((role) => {
  const baselineMs = left.get(role) ?? null, candidateMs = right.get(role) ?? null
  return { role, baselineMs, candidateMs, deltaMs: baselineMs !== null && candidateMs !== null ? candidateMs - baselineMs : null,
    deltaPercent: baselineMs && candidateMs !== null ? (candidateMs - baselineMs) / baselineMs * 100 : null }
}).sort((x, y) => (y.baselineMs ?? 0) - (x.baselineMs ?? 0))
await writeFile(output, JSON.stringify({ note: 'Compare repeated runs with matching environment and workload. Sampling estimates are not startup latency; missing roles are not zero.', profiles }, null, 2) + '\n')
for (const p of profiles) console.log(`${p.role}: ${p.baselineMs?.toFixed(1) ?? 'missing'} -> ${p.candidateMs?.toFixed(1) ?? 'missing'} ms (${p.deltaPercent?.toFixed(1) ?? 'n/a'}%)`)
