// Investigation prototype for hierarchical, query/fragment-free resource URIs.
// UNC-shaped compiler roots keep TypeScript ancestor walks within each mount.
export class CompilerPathMap {
  private readonly mounts = new Map<string, string>()
  private readonly roots = new Map<string, string>()
  private readonly forward = new Map<string, string>()
  private readonly reverse = new Map<string, string>()

  toCompiler(uri: string): string {
    const known = this.forward.get(uri)
    if (known !== undefined) return known
    const url = new URL(uri)
    if (url.search || url.hash) throw new Error('Prototype requires an explicit policy for query/fragment identities')
    if (!uri.includes('://')) throw new Error('Expected a hierarchical URI')
    const authorityStart = url.protocol.length + 2
    const authorityEnd = url.href.indexOf('/', authorityStart)
    let root = url.href.slice(0, authorityEnd === -1 ? url.href.length : authorityEnd) + '/'
    let tail = url.pathname.slice(1)
    const drive = url.protocol === 'file:' && !url.host && /^([a-zA-Z]:)\/(.*)$/.exec(tail)
    if (drive) { root += drive[1] + '/'; tail = drive[2] }
    const decoded = tail.split('/').map(segment => {
      const value = decodeURIComponent(segment)
      if (value.includes('/') || value.includes('\\')) throw new Error('Encoded separators require a provider-specific policy')
      return value
    }).join('/')
    let prefix = this.mounts.get(root)
    if (!prefix) {
      prefix = `//lvce-mount-${this.mounts.size}/`
      this.mounts.set(root, prefix); this.roots.set(prefix, root)
    }
    const path = prefix + decoded
    this.forward.set(uri, path)
    // Keep the first spelling for aliases of the same provider resource.
    if (!this.reverse.has(path)) this.reverse.set(path, url.href)
    return path
  }

  toUri(path: string): string {
    const known = this.reverse.get(path)
    if (known !== undefined) return known
    const end = path.indexOf('/', 2)
    const prefix = path.slice(0, end + 1)
    const root = this.roots.get(prefix)
    if (!root) throw new Error(`Outside registered compiler mounts: ${path}`)
    const tail = path.slice(end + 1)
    if (tail.split('/').some(segment => segment === '.' || segment === '..')) throw new Error('Expected a normalized compiler path')
    const uri = root + tail.split('/').map(encodeURIComponent).join('/')
    this.reverse.set(path, uri); this.forward.set(uri, path)
    return uri
  }
}
