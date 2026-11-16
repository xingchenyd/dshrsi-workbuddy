import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { callEndpoint, readEndpoint, request } from '../../packages/workbuddy-rsi/src/client.mjs'

const hookFile = fileURLToPath(new URL('../../packages/workbuddy-rsi/bin/hook.mjs', import.meta.url))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function stop(home) {
  await request({ op: 'stop' }, { home })
  for (let tries = 0; tries < 100 && readEndpoint(home); tries++) await pause(20)
  assert.equal(readEndpoint(home), undefined, 'helper did not remove its endpoint after stopping')
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-rsi-ipc-'))
  const home = path.join(root, 'state')
  const cwd = path.join(root, 'workspace with spaces')
  fs.mkdirSync(cwd)
  t.after(async () => { await stop(home); fs.rmSync(root, { recursive: true, force: true }) })
  return { root, home, cwd }
}
function runHook(home, cwd, event, extra = {}) {
  const input = typeof event === 'string' && event.startsWith('{') ? event : JSON.stringify({ hook_event_name: event, session_id: 'subprocess-session', cwd, ...extra })
  const result = spawnSync(process.execPath, [hookFile], { input, encoding: 'utf8', cwd, windowsHide: true, timeout: 20000, env: { ...process.env, WB_RSI_HOME: home } })
  return { ...result, output: result.stdout ? JSON.parse(result.stdout) : undefined }
}

test('separate hook processes share a live engine, then reload persisted adaptations after restart', { timeout: 30000 }, async t => {
  const { home, cwd } = fixture(t)
  assert.equal(runHook(home, cwd, 'SessionStart').status, 0)
  const original = readEndpoint(home)
  assert.ok(original)
  for (let i = 0; i < 2; i++) {
    const input = { tool_use_id: `failure-${i}`, tool_name: 'execute_command', tool_input: { command: 'frobnicate test' } }
    assert.equal(runHook(home, cwd, 'PreToolUse', input).status, 0)
    const post = runHook(home, cwd, 'PostToolUse', { ...input, tool_response: { stderr: 'bash: frobnicate: command not found', exit_code: 127 } })
    assert.equal(post.status, 0, post.stderr)
    if (i === 1) assert.match(JSON.stringify(post.output), /frobnicate.*not installed/)
  }
  const status = await request({ op: 'status' }, { home })
  assert.equal(status.records.length, 1)
  assert.equal(readEndpoint(home).pid, original.pid)
  await stop(home)
  const restored = runHook(home, cwd, 'SessionStart')
  assert.equal(restored.status, 0, restored.stderr)
  assert.match(JSON.stringify(restored.output), /frobnicate.*not installed/)
  assert.notEqual(readEndpoint(home).token, original.token)
  assert.equal((await request({ op: 'status' }, { home })).records.length, 1)
})

test('parallel clients start one helper and invalid bearer tokens cannot read or change state', { timeout: 30000 }, async t => {
  const { home } = fixture(t)
  const starts = await Promise.all(Array.from({ length: 4 }, () => request({ op: 'ping' }, { home })))
  assert.equal(new Set(starts.map(x => x.pid)).size, 1)
  const endpoint = readEndpoint(home)
  await assert.rejects(callEndpoint({ ...endpoint, token: '0'.repeat(64) }, { op: 'off' }), /forbidden/)
  assert.equal((await request({ op: 'status' }, { home })).enabled, true)
  await assert.rejects(request({ op: 'arbitrary-command', command: 'echo should not execute' }, { home }), /unknown operation/)
  await assert.rejects(request({ op: 'show', id: '../outside' }, { home }), /invalid adaptation id/)
})

test('malformed and oversized hook input are nonblocking errors with clean stdout', { timeout: 30000 }, async t => {
  const { home, cwd } = fixture(t)
  const secret = 'ghp_abcdefghijklmnopqrstuvwx'
  const malformed = runHook(home, cwd, `{${secret}`)
  assert.equal(malformed.status, 1)
  assert.deepEqual(malformed.output, {})
  assert.equal(malformed.stderr.includes(secret), false)
  assert.equal(readEndpoint(home), undefined)
  const tooBig = runHook(home, cwd, 'SessionStart', { irrelevant: 'x'.repeat(1024 * 1024) })
  assert.equal(tooBig.status, 1)
  assert.deepEqual(tooBig.output, {})
  assert.match(tooBig.stderr, /exceeds 1 MiB/)
})
