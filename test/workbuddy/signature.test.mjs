import assert from 'node:assert/strict'
import test from 'node:test'
import { commandPositionSource, runsProgram } from '../../packages/dsh-rsi/src/signature.js'
import { describeOutcome } from '../../packages/dsh-rsi/src/normalize.js'

for (const program of ['clang++', 'python3.13', 'my.tool', 'foo.exe']) {
  test(`command matching treats ${program} as a literal executable name`, () => {
    assert.doesNotThrow(() => new RegExp(commandPositionSource(program)))
    for (const command of [program, `${program} --version`, `PATH=/tmp ${program} test`, `echo before; ${program} test`]) {
      assert.equal(runsProgram(command, program), true, command)
    }
    for (const command of [`command -v ${program}`, `echo ${program}`, `${program}-other test`, `prefix-${program} test`]) {
      assert.equal(runsProgram(command, program), false, command)
    }
  })
}

test('dots and plus signs cannot match another executable through regex metacharacters', () => {
  assert.equal(runsProgram('python3X13 --version', 'python3.13'), false)
  assert.equal(runsProgram('myXtool test', 'my.tool'), false)
  assert.equal(runsProgram('fooXexe test', 'foo.exe'), false)
  assert.equal(runsProgram('clangg test', 'clang++'), false)
})

test('masked exit zero for a missing dotted command is still a failed call', () => {
  const result = describeOutcome('bash', 'bash: python3.13: command not found\n[exit code: 0]', false, undefined, 'python3.13 --version || true')
  assert.equal(result.ok, false)
  assert.equal(result.masked, true)
  const diagnostic = describeOutcome('bash', 'bash: python3.13: command not found\n[exit code: 0]', false, undefined, 'echo python3.13')
  assert.equal(diagnostic.ok, true)
})
