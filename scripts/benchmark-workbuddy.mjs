#!/usr/bin/env node
// Controlled mechanism benchmark. The driver is deterministic, not an LLM.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createWorkBuddyHost } from '../packages/workbuddy-rsi/src/host.mjs'

const MISSING = 'wbrsi_benchmark_missing_8c96d'
const payload = (cwd, session, event, extra = {}) => ({ cwd, session_id: session, hook_event_name: event, ...extra })

function execute(program, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', spawnError
    child.stdout.on('data', value => { stdout += value })
    child.stderr.on('data', value => { stderr += value })
    child.once('error', error => { spawnError = error })
    const timer = setTimeout(() => { child.kill(); reject(new Error('benchmark command timed out')) }, 10000)
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer)
      if (spawnError && spawnError.code !== 'ENOENT') return reject(spawnError)
      resolve({ stdout, stderr, error: spawnError?.message, tool_error_code: spawnError?.code, exitCode, signal, is_error: Boolean(spawnError) || exitCode !== 0 })
    })
  })
}

async function begin(host, cwd, session) {
  const first = await host.handleHook(payload(cwd, session, 'SessionStart'))
  await host.handleHook(payload(cwd, session, 'UserPromptSubmit', { prompt: 'Exercise the fixed benchmark workload.' }))
  return Boolean(first.output.hookSpecificOutput?.additionalContext?.includes(MISSING))
}

async function tool(host, cwd, session, id, kind, command, program, args) {
  const input = { tool_use_id: id, tool_name: 'Bash', tool_input: { command } }
  const pre = await host.handleHook(payload(cwd, session, 'PreToolUse', input))
  const decision = pre.output.hookSpecificOutput?.permissionDecision
  if (decision) return { id, kind, decision, execution: 'prevented' }
  const response = await execute(program, args, cwd)
  if (kind === 'missing' && response.tool_error_code !== 'ENOENT') throw new Error('The deliberately absent executable unexpectedly exists; benchmark aborted')
  if (kind === 'healthy' && response.exitCode !== 0) throw new Error('The healthy control command failed; benchmark invalid')
  await host.handleHook(payload(cwd, session, 'PostToolUse', { ...input, tool_response: response }))
  return { id, kind, decision: 'pass', execution: response.is_error ? 'failed' : 'succeeded', exitCode: response.exitCode, errorCode: response.tool_error_code ?? null }
}

const missing = (host, cwd, session, id) => tool(host, cwd, session, id, 'missing', `${MISSING} --version`, MISSING, ['--version'])
const healthy = (host, cwd, session, id) => tool(host, cwd, session, id, 'healthy', 'node --version', process.execPath, ['--version'])
function counts(trace) {
  const problem = trace.filter(row => row.kind === 'missing')
  const controls = trace.filter(row => row.kind === 'healthy')
  return {
    missingAttempts: problem.length,
    failedProcessStarts: problem.filter(row => row.execution === 'failed').length,
    preventedProcessStarts: problem.filter(row => row.execution === 'prevented').length,
    healthyAttempts: controls.length,
    healthySucceeded: controls.filter(row => row.execution === 'succeeded').length,
    healthyPrevented: controls.filter(row => row.execution === 'prevented').length,
  }
}

async function repeatedFailures(root, enabled) {
  const cwd = path.join(root, enabled ? 'repeated-on' : 'repeated-off')
  const home = path.join(root, enabled ? 'library-on' : 'library-off')
  fs.mkdirSync(cwd)
  const host = createWorkBuddyHost({ home })
  if (!enabled) host.setEnabled(false)
  try {
    await begin(host, cwd, 'cold')
    const coldTrace = []
    // Both arms receive exactly the same attempted workload. The driver does not
    // obey notes: only the actual PreToolUse guard can prevent a process start.
    for (let i = 1; i <= 12; i++) {
      coldTrace.push(await missing(host, cwd, 'cold', `cold-missing-${i}`))
      if (i % 3 === 0) coldTrace.push(await healthy(host, cwd, 'cold', `cold-healthy-${i / 3}`))
    }
    const cold = { ...counts(coldTrace), trace: coldTrace }
    const validationStages = [...new Set(host.status().records.flatMap(record => record.validation?.stages?.map(stage => stage.stage) ?? []))]
    await host.handleHook(payload(cwd, 'cold', 'Stop'))
    await host.handleHook(payload(cwd, 'cold', 'SessionEnd'))
    return { cold, validationStages }
  } finally { host.dispose() }
}

async function reuseAfterRestart(root, enabled) {
  // Separate from the long retry trial: two initial failures learn a prompt
  // and a guard; later repeated failures can revise that into a guard-only rule.
  const cwd = path.join(root, enabled ? 'restart-on' : 'restart-off')
  const home = path.join(root, enabled ? 'restart-library-on' : 'restart-library-off')
  fs.mkdirSync(cwd)
  let host = createWorkBuddyHost({ home })
  if (!enabled) host.setEnabled(false)
  try {
    await begin(host, cwd, 'training')
    const trainingTrace = []
    for (let i = 1; i <= 2; i++) trainingTrace.push(await missing(host, cwd, 'training', `training-missing-${i}`))
    await host.handleHook(payload(cwd, 'training', 'Stop'))
    await host.handleHook(payload(cwd, 'training', 'SessionEnd'))
    const adaptationsBeforeRestart = host.status().records.length
    host.dispose()
    host = createWorkBuddyHost({ home })
    const adaptationsAfterRestart = host.status().records.length
    const startupContext = await begin(host, cwd, 'warm')
    const warmTrace = []
    for (let i = 1; i <= 6; i++) {
      warmTrace.push(await missing(host, cwd, 'warm', `warm-missing-${i}`))
      if (i % 3 === 0) warmTrace.push(await healthy(host, cwd, 'warm', `warm-healthy-${i / 3}`))
    }
    return { ...counts(warmTrace), training: { ...counts(trainingTrace), trace: trainingTrace }, adaptationsBeforeRestart, adaptationsAfterRestart, startupContext, trace: warmTrace }
  } finally { host.dispose() }
}

async function verification(root, enabled) {
  const cwd = path.join(root, enabled ? 'verification-on' : 'verification-off')
  fs.mkdirSync(cwd)
  const host = createWorkBuddyHost({ home: path.join(cwd, 'state') })
  if (!enabled) host.setEnabled(false)
  try {
    await begin(host, cwd, 'verification')
    const input = { tool_use_id: 'write-1', tool_name: 'Write', tool_input: { file_path: 'example.mjs', content: 'export const answer = 42\n' } }
    const pre = await host.handleHook(payload(cwd, 'verification', 'PreToolUse', input))
    if (pre.output.hookSpecificOutput?.permissionDecision) throw new Error('Fresh control write unexpectedly blocked')
    fs.writeFileSync(path.join(cwd, 'example.mjs'), input.tool_input.content)
    await host.handleHook(payload(cwd, 'verification', 'PostToolUse', { ...input, tool_response: { success: true, text: 'File written.' } }))
    const unverified = await host.handleHook(payload(cwd, 'verification', 'Stop'))
    // Deliberately run the same real syntax check in both arms. The ON arm asks
    // for it; the OFF arm's driver schedules it in the following turn.
    if (unverified.output.decision !== 'block') await host.handleHook(payload(cwd, 'verification', 'UserPromptSubmit', { prompt: 'Run the planned syntax check.' }))
    const check = await tool(host, cwd, 'verification', 'syntax-check', 'healthy', 'node --check example.mjs', process.execPath, ['--check', 'example.mjs'])
    const verified = await host.handleHook(payload(cwd, 'verification', 'Stop'))
    return {
      actualFilesWritten: 1,
      unverifiedStopBlocked: unverified.output.decision === 'block',
      realSyntaxChecksPassed: check.execution === 'succeeded' ? 1 : 0,
      verifiedStopAllowed: verified.output.decision !== 'block',
      interpretation: 'A request to verify, not proof that an arbitrary edit is correct. Both arms run the same real syntax check.',
    }
  } finally { host.dispose() }
}

export async function runBenchmark() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-rsi-benchmark-'))
  try {
    const off = await repeatedFailures(root, false)
    const on = await repeatedFailures(root, true)
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      environment: { platform: process.platform, arch: process.arch, node: process.version },
      evidenceClass: 'controlled mechanism benchmark with real OS subprocess attempts and real file I/O',
      modelCalls: 0,
      workbuddyDesktopModelSession: false,
      generator: 'synth',
      methodology: {
        driver: 'Fixed workload, independent fresh OFF and ON libraries; no live model or desktop conversation.',
        hookTransport: 'In-process createWorkBuddyHost.handleHook receives WorkBuddy-shaped payloads; this workload does not exercise the daemon transport or WorkBuddy desktop.',
        failures: 'The OS is asked to spawn a deliberately absent executable. ENOENT must be observed; no fabricated shell failure text is used.',
        control: 'OFF uses the actual adapter off switch. ON uses default adaptation settings. Healthy commands run the current Node executable.',
        repeatedAttempts: 'The driver deliberately ignores injected suggestions, so the measurement isolates hook enforcement.',
        probes: 'The engine may deliberately allow a later retry to check whether the learned refusal is still valid; these retries count as failed process starts.',
        restart: 'An independent fixture learns from two real failed starts, then the host is disposed and reopened against the same on-disk library. Live handler counters reset. Training costs are reported separately and must not be omitted from whole-workload totals.',
        startupContext: 'True only when the reopened host returns context containing the deliberately absent executable name.',
        boundaries: 'Not an LLM benchmark, not a WorkBuddy GUI test, not a task-success or latency study. One deliberately selected workload per arm.',
      },
      scenarios: {
        repeatedMissingCommand: { off: off.cold, on: on.cold },
        restartAndReuse: { off: await reuseAfterRestart(root, false), on: await reuseAfterRestart(root, true) },
        verification: { off: await verification(root, false), on: await verification(root, true) },
      },
      observedValidationStages: on.validationStages,
    }
  } finally {
    // mkdtemp creates this exact absolute fixture root. Nothing outside it is removed.
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  if (args.length && (args.length !== 2 || args[0] !== '--output')) throw new Error('Usage: node scripts/benchmark-workbuddy.mjs [--output FILE]')
  const result = await runBenchmark()
  const json = `${JSON.stringify(result, null, 2)}\n`
  if (args[0] === '--output') {
    const target = path.resolve(args[1])
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, json)
  }
  process.stdout.write(json)
}
