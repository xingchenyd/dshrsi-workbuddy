import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { canonicalTool, contextOutput, normalizeCall, normalizeHook, normalizeResult, redact } from '../../packages/workbuddy-rsi/src/protocol.mjs'

test('desktop and CLI tool names normalize to upstream semantics', () => {
  for (const name of ['execute_command', 'Bash', 'bash']) assert.equal(canonicalTool(name), 'bash')
  for (const name of ['PowerShell', 'Pwsh', 'powershell']) assert.equal(canonicalTool(name), 'pwsh')
  const edited = normalizeCall({ tool_name: 'replace_in_file', tool_input: { path: 'src/main.js', diff: 'changed' } })
  assert.equal(edited.tool, 'edit')
  assert.equal(edited.path, 'src/main.js')
  assert.equal(edited.mutating, true)
  const command = normalizeCall({ tool_name: 'execute_command', tool_input: JSON.stringify({ command_line: 'node --test' }) })
  assert.equal(command.command, 'node --test')
  assert.equal(command.verifying, true)
  assert.equal(normalizeCall({ tool_name: 'custom_readonly', tool_input: {} }).tool, 'custom_readonly')
})

test('nonzero shell exit, explicit failure event and success:false are failures', () => {
  const call = { tool_name: 'execute_command', tool_input: { command: 'node --test' } }
  for (const payload of [
    { ...call, hook_event_name: 'PostToolUse', tool_response: { stdout: 'test failed', stderr: 'details', exit_code: 1 } },
    { ...call, hook_event_name: 'PostToolUseFailure', error: 'command could not start' },
    { ...call, hook_event_name: 'PostToolUse', tool_response: { text: 'operation failed', success: false } },
  ]) assert.equal(normalizeResult(payload).ok, false)
  const good = normalizeResult({ ...call, hook_event_name: 'PostToolUse', tool_response: { content: [{ type: 'text', text: 'passed' }], exitCode: 0 } })
  assert.equal(good.ok, true)
  assert.match(good.text, /passed/)
})

test('shell error text is observed even if a wrapper masks the exit status', () => {
  const result = normalizeResult({ hook_event_name: 'PostToolUse', tool_name: 'execute_command', tool_input: { command: 'python3.13 test.py || true' }, tool_response: { output: 'bash: python3.13: command not found', exit_code: 0 } })
  assert.equal(result.ok, false)
  assert.equal(result.masked, true)
})

test('native WorkBuddy rawResponse retains exit status, interruption and sandbox denial', () => {
  // Shapes verified in the installed Desktop CLI 2.176.0: Bash.buildForegroundResult,
  // PowerShell.buildResult, and ToolManager.extractRawResponse. No task logs are used.
  const shell = { hook_event_name: 'PostToolUse', tool_name: 'PowerShell', tool_input: { command: 'node --test' } }
  const completed = normalizeResult({ ...shell, tool_response: { exitCode: 0, signal: null, interrupted: false } })
  assert.equal(completed.ok, true)
  const failed = normalizeResult({ ...shell, tool_response: { exitCode: 1, signal: null, interrupted: false } })
  assert.equal(failed.ok, false)
  const cancelled = normalizeResult({ ...shell, tool_response: { exitCode: null, signal: 'SIGTERM', interrupted: true } })
  assert.equal(cancelled.ok, false)
  assert.equal(cancelled.interrupted, true)
  assert.equal(cancelled.signal, 'SIGTERM')
  assert.equal(normalizeResult({ ...shell, tool_response: { exitCode: null, signal: null, interrupted: true } }).ok, false)
  assert.equal(normalizeResult({ ...shell, tool_response: { exitCode: null, signal: 'SIGKILL', interrupted: false } }).ok, false)
  const denied = normalizeResult({ ...shell, tool_name: 'Bash', tool_response: { exitCode: null, signal: null, interrupted: false, sandboxDenied: true, tool_error_code: 'SANDBOX_DENIED', is_error: true, error: 'access blocked' } })
  assert.equal(denied.ok, false)
  assert.equal(denied.denied, true)
  assert.equal(denied.errorCode, 'SANDBOX_DENIED')
  const numericCode = normalizeResult({ ...shell, tool_response: { exitCode: 1, tool_error_code: 55001, is_error: true, error: 'execution failed' } })
  assert.equal(numericCode.errorCode, '55001')
  const topLevel = normalizeResult({ ...shell, tool_error_code: 'HOST_ERROR', tool_response: { exitCode: 1, tool_error_code: 'TOOL_ERROR' } })
  assert.equal(topLevel.errorCode, 'HOST_ERROR')
})

test('secret-shaped input and output fields are redacted before observations', () => {
  const secret = 'ghp_abcdefghijklmnopqrstuvwx'
  const call = normalizeCall({ tool_name: 'execute_command', tool_input: { command: `curl -H "Authorization: Bearer ${secret}"`, api_key: 'private-test-key', nested: { password: 'do-not-store' } } })
  const serialized = JSON.stringify(call)
  for (const token of [secret, 'private-test-key', 'do-not-store']) assert.equal(serialized.includes(token), false)
  const result = normalizeResult({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {}, tool_response: `password=do-not-store\n${secret}` })
  assert.equal(result.text.includes(secret), false)
  assert.equal(result.text.includes('do-not-store'), false)
  assert.match(redact('an ordinary error'), /^an ordinary error$/)
})

test('invalid identities and hook events are refused', () => {
  for (const payload of [null, [], {}, { hook_event_name: 'Arbitrary', session_id: 's' }, { hook_event_name: 'Stop', session_id: '' }, { hook_event_name: 'Stop', session_id: 'x'.repeat(257) }]) {
    assert.throws(() => normalizeHook(payload))
  }
  assert.throws(() => normalizeCall({ tool_name: 'Bash', tool_input: [] }))
  for (const cwd of ['relative/path', 42, null]) assert.throws(() => normalizeHook({ hook_event_name: 'Stop', session_id: 's', cwd }), /cwd/)
  const normalized = normalizeHook({ hook_event_name: 'Stop', session_id: '../../not-a-path', cwd: path.resolve('test') })
  assert.equal(normalized.sessionId, '../../not-a-path')
  assert.equal(normalized.cwd, path.resolve('test'))
  assert.equal(canonicalTool('__proto__'), '__proto__')
  assert.equal(canonicalTool('constructor'), 'constructor')
})

test('hook output cannot grant permission and deny takes precedence over ask', () => {
  assert.deepEqual(contextOutput('PreToolUse', [], { allow: true }), {})
  const decision = contextOutput('PreToolUse', ['one', 'one'], { deny: 'failed twice', ask: 'confirm' }).hookSpecificOutput
  assert.equal(decision.permissionDecision, 'deny')
  assert.equal(decision.permissionDecisionReason, 'failed twice')
  assert.equal(decision.additionalContext, 'one')
  assert.equal(contextOutput('PreToolUse', [], { ask: 'confirm' }).hookSpecificOutput.permissionDecision, 'ask')
  assert.equal(contextOutput('PostToolUse', ['context'], { deny: 'not a pre-hook' }).hookSpecificOutput.permissionDecision, undefined)
})
