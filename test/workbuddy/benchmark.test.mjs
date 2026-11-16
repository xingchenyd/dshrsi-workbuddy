import assert from 'node:assert/strict'
import test from 'node:test'
import { runBenchmark } from '../../scripts/benchmark-workbuddy.mjs'

test('controlled benchmark reproduces real failure prevention, persisted context and verification without blocking healthy commands', { timeout: 30000 }, async () => {
  const result = await runBenchmark()
  assert.equal(result.modelCalls, 0)
  assert.equal(result.workbuddyDesktopModelSession, false)
  const { repeatedMissingCommand: cold, restartAndReuse: warm, verification } = result.scenarios
  for (const [scenario, attempts, healthy] of [[cold, 12, 4], [warm, 6, 2]]) {
    for (const arm of [scenario.off, scenario.on]) {
      assert.equal(arm.missingAttempts, attempts)
      assert.equal(arm.failedProcessStarts + arm.preventedProcessStarts, attempts)
      assert.equal(arm.healthyAttempts, healthy)
      assert.equal(arm.healthySucceeded, healthy)
      assert.equal(arm.healthyPrevented, 0)
      for (const entry of arm.trace.filter(row => row.kind === 'missing' && row.execution === 'failed')) assert.equal(entry.errorCode, 'ENOENT')
      for (const entry of arm.trace.filter(row => row.execution === 'prevented')) assert.equal(entry.decision, 'deny')
    }
    assert.equal(scenario.off.failedProcessStarts, attempts)
    assert.equal(scenario.off.preventedProcessStarts, 0)
    assert.ok(scenario.on.failedProcessStarts < scenario.off.failedProcessStarts)
  }
  // Pin the recorded comparison to this fixed workload; a policy change should
  // require re-running and reviewing the published evidence, not silently drift.
  assert.equal(cold.on.failedProcessStarts, 5)
  assert.equal(cold.on.preventedProcessStarts, 7)
  assert.equal(warm.on.failedProcessStarts, 3)
  assert.equal(warm.on.preventedProcessStarts, 3)
  for (const arm of [warm.off, warm.on]) {
    assert.equal(arm.training.missingAttempts, 2)
    assert.equal(arm.training.failedProcessStarts, 2)
  }
  assert.equal(warm.off.adaptationsAfterRestart, 0)
  assert.equal(warm.off.startupContext, false)
  assert.equal(warm.on.adaptationsBeforeRestart, 1)
  assert.equal(warm.on.adaptationsAfterRestart, 1)
  assert.equal(warm.on.startupContext, true)
  assert.equal(verification.off.unverifiedStopBlocked, false)
  assert.equal(verification.on.unverifiedStopBlocked, true)
  for (const arm of [verification.off, verification.on]) {
    assert.equal(arm.actualFilesWritten, 1)
    assert.equal(arm.realSyntaxChecksPassed, 1)
    assert.equal(arm.verifiedStopAllowed, true)
  }
  assert.deepEqual(result.observedValidationStages, ['static', 'load', 'rehearsal', 'regression', 'policy'])
})
