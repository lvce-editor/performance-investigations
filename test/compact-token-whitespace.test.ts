import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { compactTokenWhitespace } from '../src/compact-token-whitespace.ts'

test('preserves ASI, token spelling, regex, templates, comments and execution', () => {
  const source = `
    function string() {
      return
      42
    }
    const literal = \`  raw
        text \${1 + 2}  \`
    const regexp = /a +b/g
    const result = [string(), literal, regexp.source]
    // A line comment must not consume the following statement.
    result.push(1)
    /* @license retained verbatim */
    result.push(2)
    globalThis.result = result
  `
  const compact = compactTokenWhitespace(source)
  const run = (code: string) => {
    const target = {}
    new Function('globalThis', code)(target)
    return target
  }
  assert.deepEqual(run(compact), run(source))
  assert.ok(compact.length < source.length)
  assert.ok(compact.includes('/* @license retained verbatim */'))
  assert.ok(compact.includes('function string()'))
  assert.ok(compact.includes('        text'))
})

test('preserves adjacent operators, destructuring shorthand and arrow blocks', () => {
  const source = `let a = 1; const { value } = { value: 3 }; const f = () => { return value }; a + ++a; export { a, f }\n`
  const compact = compactTokenWhitespace(source)
  assert.ok(compact.includes('a + ++a'))
  assert.ok(compact.includes('{value}'))
  assert.ok(compact.includes('=>{return value}'))
})
