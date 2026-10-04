export interface Frame {
  functionName: string
  url?: string
  lineNumber?: number
  columnNumber?: number
}
export interface ProfileNode { id: number; callFrame: Frame; parent?: number; children?: number[] }
export interface Profile {
  nodes: ProfileNode[]
  samples: number[]
  timeDeltas: number[]
  startTime: number
  endTime?: number
  key?: string
  pid?: number
  tid?: number
  thread?: string
}
export interface TraceEvent {
  name: string
  pid: number
  tid: number
  ts: number
  dur?: number
  ph: string
  id?: string | number
  args?: any
}

export const reconstruct = (events: TraceEvent[]): { profiles: Profile[]; excluded: string[] } => {
  const profiles = new Map<string, Profile>()
  const threads = new Map<string, string>()
  for (const event of events) {
    if (event.name === 'thread_name') threads.set(`${event.pid}:${event.tid}`, event.args.name)
    if (event.name !== 'Profile' && event.name !== 'ProfileChunk') continue
    const key = `${event.pid}:${event.id}`
    const data = event.args?.data
    if (!data) throw new Error(`Missing profile data: ${key}`)
    if (event.name === 'Profile') {
      if (profiles.has(key)) throw new Error(`Duplicate profile start: ${key}`)
      profiles.set(key, { key, pid: event.pid, tid: event.tid, startTime: data.startTime, nodes: [], samples: [], timeDeltas: [] })
      continue
    }
    const profile = profiles.get(key)
    if (!profile) throw new Error(`Profile chunk without a start: ${key}`)
    for (const node of data.cpuProfile?.nodes ?? []) profile.nodes.push(node)
    for (const sample of data.cpuProfile?.samples ?? []) profile.samples.push(sample)
    for (const delta of data.timeDeltas ?? []) profile.timeDeltas.push(delta)
  }
  // Inspector and Chromium can profile the same utility isolate simultaneously.
  // Keep the stream with the most samples; totals must not count either twice.
  const selected = new Map<string, Profile>()
  const excluded: string[] = []
  for (const profile of profiles.values()) {
    profile.thread = threads.get(`${profile.pid}:${profile.tid}`) ?? 'unknown'
    const threadKey = `${profile.pid}:${profile.tid}`
    const previous = selected.get(threadKey)
    if (!previous || profile.samples.length > previous.samples.length) {
      if (previous) excluded.push(previous.key!)
      selected.set(threadKey, profile)
    } else excluded.push(profile.key!)
  }
  return { profiles: [...selected.values()], excluded }
}

export const cleanUrl = (url = ''): string => {
  const withoutQuery = url.split(/[?#]/, 1)[0].replace(/http:\/\/(?:localhost|127\.0\.0\.1):\d+\//g, '<server>/')
  const cleaned = withoutQuery.replace(/<server>\/[^/]+\/packages\//g, '<app>/packages/').replace(/<server>\/remote.*?\/packages\/extension\/dist\//g, '<app>/extensions/builtin.eslint/dist/').replace(/\/home\/[^/]+\/Documents\/levivilet\//g, '<repos>/')
    .replace(/\/usr\/lib\/lvce\/resources\/app\/static\/[^/]+\//g, '<app>/')
    .replace(/(?:file:\/\/)?\/usr\/lib\/lvce\/resources\/app\//g, '<app>/')
    .replace(/lvce:\/\/-\/[^/]+\/packages\//g, '<app>/packages/')
    .replace(/lvce:\/\/-\/[^/]+\/extensions\//g, '<app>/extensions/')
  const appIndex = cleaned.indexOf('<app>')
  return appIndex === -1 ? cleaned : cleaned.slice(appIndex)
}
const label = (frame: Frame): string => `${frame.functionName || '(anonymous)'} @ ${cleanUrl(frame.url)}:${(frame.lineNumber ?? -1) + 1}:${(frame.columnNumber ?? -1) + 1}`
const round = (us: number): number => Math.round(us) / 1000
const top = (values: Map<string, number>, limit = 25) => [...values.entries()]
  .sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name, us]) => ({ name, ms: round(us) }))
const add = <T>(values: Map<T, number>, key: T, value: number) => values.set(key, (values.get(key) ?? 0) + value)

export const summarize = (profile: Profile, origin = profile.startTime, windowMs?: number) => {
  if (profile.samples.length !== profile.timeDeltas.length) throw new Error('Sample/timeDelta length mismatch')
  if (!Number.isFinite(profile.startTime)) throw new Error('Invalid profile start time')
  const nodes = new Map<number, ProfileNode>()
  const parents = new Map<number, number>()
  for (const node of profile.nodes) {
    if (nodes.has(node.id)) throw new Error(`Duplicate node id ${node.id}`)
    nodes.set(node.id, node)
    if (node.parent !== undefined) parents.set(node.id, node.parent)
    for (const child of node.children ?? []) parents.set(child, node.id)
  }
  const points: { time: number; id: number }[] = []
  let time = profile.startTime
  let negativeDeltas = 0
  for (let i = 0; i < profile.samples.length; i++) {
    const delta = profile.timeDeltas[i]
    if (!Number.isFinite(delta)) throw new Error('Invalid time delta')
    if (delta < 0) negativeDeltas++
    time += delta
    if (!nodes.has(profile.samples[i])) throw new Error(`Unknown sampled node ${profile.samples[i]}`)
    points.push({ time, id: profile.samples[i] })
  }
  // V8 sometimes emits samples out of timestamp order. Reorder timestamps,
  // never clamp deltas before accumulation (which shifts the entire timeline).
  points.sort((a, b) => a.time - b.time)
  const end = profile.endTime ?? points.at(-1)?.time ?? profile.startTime
  const stop = Math.min(end, windowMs === undefined ? Infinity : origin + windowMs * 1000)
  const nodeTimes = new Map<number, number>()
  const buckets = new Map<number, number>()
  const states = new Map<string, number>()
  let firstActive: number | undefined
  let lastActive: number | undefined
  let longGaps = 0
  let earlyActive = 0
  for (let i = 0; i < points.length; i++) {
    const point = points[i]
    const start = Math.max(origin, profile.startTime, point.time)
    const finish = Math.min(stop, points[i + 1]?.time ?? end)
    const duration = Math.max(0, finish - start)
    if (!duration) continue
    if (duration > 10_000) longGaps++
    add(nodeTimes, point.id, duration)
    const name = nodes.get(point.id)!.callFrame.functionName
    const state = name === '(idle)' ? 'idle' : name === '(program)' ? 'unattributed' : name === '(garbage collector)' ? 'gc' : 'javascriptOrNative'
    add(states, state, duration)
    if (state === 'idle') continue
    firstActive ??= start
    lastActive = finish
    earlyActive += Math.max(0, Math.min(finish, origin + 5_000_000) - start)
    for (let cursor = start; cursor < finish;) {
      const bin = Math.floor((cursor - origin) / 1_000_000)
      const next = Math.min(finish, origin + (bin + 1) * 1_000_000)
      buckets.set(bin, (buckets.get(bin) ?? 0) + next - cursor)
      cursor = next
    }
  }
  const self = new Map<string, number>()
  const inclusive = new Map<string, number>()
  const urls = new Map<string, number>()
  for (const [id, duration] of nodeTimes) {
    const frame = nodes.get(id)!.callFrame
    add(self, label(frame), duration)
    add(urls, cleanUrl(frame.url) || frame.functionName, duration)
    const seenIds = new Set<number>()
    const seenLabels = new Set<string>()
    let current: number | undefined = id
    while (current !== undefined) {
      if (seenIds.has(current)) throw new Error('Cycle in profile stack')
      seenIds.add(current)
      const node = nodes.get(current)
      if (!node) throw new Error(`Missing parent node ${current}`)
      seenLabels.add(label(node.callFrame))
      current = parents.get(current)
    }
    for (const key of seenLabels) add(inclusive, key, duration)
  }
  const ownBundle = [...urls.entries()].filter(([url]) => /(?:Main|index)\.js$/.test(url) && /(?:packages|extensions)\//.test(url))
    .sort((a, b) => b[1] - a[1])[0]?.[0]
  return {
    key: profile.key ?? 'standalone', pid: profile.pid, tid: profile.tid, thread: profile.thread,
    role: [...urls.keys()].some((u) => u.includes('/shared-process/src/')) ? 'shared-process' : ownBundle?.includes('/file-system-process/') ? 'file-system-process' : ownBundle ?? profile.thread ?? 'standalone',
    startOffsetMs: round(profile.startTime - origin), durationMs: round(Math.max(0, stop - profile.startTime)),
    observedMs: round([...states.values()].reduce((a, b) => a + b, 0)),
    nonIdleMs: round([...states].filter(([key]) => key !== 'idle').reduce((sum, [, value]) => sum + value, 0)),
    statesMs: Object.fromEntries([...states].map(([name, us]) => [name, round(us)])),
    earlyNonIdleMs: round(earlyActive),
    firstActiveOffsetMs: firstActive === undefined ? null : round(firstActive - origin),
    lastActiveOffsetMs: lastActive === undefined ? null : round(lastActive - origin),
    samples: points.length, nodes: nodes.size, negativeDeltas, gapsOver10Ms: longGaps,
    topSelf: top(self), topInclusive: top(inclusive), topUrls: top(urls),
    timeline: [...buckets].sort((a, b) => a[0] - b[0]).map(([second, us]) => ({ second, nonIdleMs: round(us) })),
  }
}
