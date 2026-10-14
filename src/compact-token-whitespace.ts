import { tokenizer } from 'acorn'
import { deepStrictEqual } from 'node:assert'
import { parseAst } from 'rollup/parseAst'

export const semanticAst = (source: string) => JSON.parse(JSON.stringify(parseAst(source), (key, value) =>
  ['start', 'end', 'raw', '_rollupAnnotations'].includes(key) ? undefined : value))

// Retain source slices for every token and comment, including template raw text.
// Retain a line terminator wherever one occurred between tokens, preserving ASI.
// Remove horizontal gaps next to delimiters that cannot join another token.
export const compactTokenWhitespace = (source: string): string => {
  const spans: { start: number, end: number }[] = []
  const tokens = tokenizer(source, {
    ecmaVersion: 'latest', sourceType: 'module',
    onComment: (_block, _text, start, end) => { spans.push({ start, end }) },
  })
  const originalTokens: string[] = []
  for (const token of tokens) {
    if (token.type.label !== 'eof') {
      spans.push({ start: token.start, end: token.end })
      originalTokens.push(source.slice(token.start, token.end))
    }
  }
  spans.sort((a, b) => a.start - b.start)
  let cursor = 0, compact = ''
  for (const span of spans) {
    const gap = source.slice(cursor, span.start)
    if (gap && !/^\s+$/.test(gap)) throw new Error('Unexpected non-whitespace outside token/comment')
    if (gap) {
      const lineBreak = /[\n\r\u2028\u2029]/.test(gap)
      const delimiter = /[(){}\[\],;]/.test(source[cursor - 1] || '') || /[(){}\[\],;]/.test(source[span.start] || '')
      compact += lineBreak ? '\n' : delimiter ? '' : ' '
    }
    compact += source.slice(span.start, span.end)
    cursor = span.end
  }
  const tail = source.slice(cursor)
  if (tail && !/^\s+$/.test(tail)) throw new Error('Unexpected non-whitespace after final token')
  if (tail) compact += /[\n\r\u2028\u2029]/.test(tail) ? '\n' : ' '
  const compactTokens = [...tokenizer(compact, { ecmaVersion: 'latest', sourceType: 'module' })]
    .filter(token => token.type.label !== 'eof').map(token => compact.slice(token.start, token.end))
  deepStrictEqual(compactTokens, originalTokens)
  // Refuse a candidate unless the independent parser agrees on the entire AST.
  deepStrictEqual(semanticAst(compact), semanticAst(source))
  return compact
}
