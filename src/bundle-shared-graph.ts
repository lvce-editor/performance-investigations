import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'

// Bundle local ESM only. Bare dependencies retain their original package loader,
// and splitting retains dynamic import boundaries and shared singleton chunks.
export const bundleSharedGraph = async (entry: string, outdir: string) => {
  const result = await build({
    absWorkingDir: dirname(dirname(resolve(entry))),
    entryPoints: [resolve(entry)], outdir: resolve(outdir), entryNames: '[name]',
    chunkNames: '[name]-[hash]', bundle: true, splitting: true,
    platform: 'node', format: 'esm', target: 'esnext', packages: 'external',
    minify: false, keepNames: true, treeShaking: false, metafile: true,
    plugins: [{
      name: 'preserve-original-module-url',
      setup(api) {
        api.onLoad({ filter: /\.js$/ }, async ({ path }) => {
          let contents = await readFile(path, 'utf8')
          if (contents.includes('import.meta.url')) {
            const originalRelative = relative(resolve(outdir), path).split(sep).join('/')
            // Root is the only production file using import.meta.url. Evaluate
            // its original URL, without changing the existing root calculation.
            if (!path.endsWith('/parts/Root/Root.js')) throw new Error(`Unreviewed import.meta.url in ${path}`)
            contents = contents.replaceAll('import.meta.url', `new URL(${JSON.stringify(originalRelative)}, import.meta.url).href`)
          }
          return { contents, loader: 'js' }
        })
      },
    }],
  })
  if (result.warnings.length) throw new Error(`Unreviewed bundler warnings: ${JSON.stringify(result.warnings)}`)
  return result.metafile
}
