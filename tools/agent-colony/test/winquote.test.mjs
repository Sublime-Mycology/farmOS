import test from 'node:test'
import assert from 'node:assert/strict'
import { winQuote } from '../lib/agents.mjs'

test('plain arguments pass through; anything else is quoted for cmd.exe', () => {
  assert.equal(winQuote('--permission-mode'), '--permission-mode')
  assert.equal(winQuote('C:\\Users\\me\\code'), 'C:\\Users\\me\\code')
  assert.equal(winQuote('Bash(python3 clipper.py:*)'), '"Bash(python3 clipper.py:*)"')
  assert.equal(winQuote('say "hi" & exit'), '"say ""hi"" & exit"')
  assert.equal(winQuote('two\nlines'), '"two lines"')
})
