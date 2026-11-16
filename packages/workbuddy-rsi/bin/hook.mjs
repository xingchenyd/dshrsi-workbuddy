#!/usr/bin/env node
import { request } from '../src/client.mjs'
import { MAX_INPUT_BYTES, redact } from '../src/protocol.mjs'

let bytes = 0
const chunks = []
try {
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > MAX_INPUT_BYTES) throw new Error('hook input exceeds 1 MiB')
    chunks.push(chunk)
  }
  let payload
  try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('hook input must be valid JSON') }
  // The helper has its own stable cwd; omitted hook cwd belongs to this short-
  // lived caller, never to the helper's state directory.
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && payload.cwd === undefined) payload.cwd = process.cwd()
  const reply = await request({ op: 'hook', payload })
  process.stdout.write(`${JSON.stringify(reply.output ?? {})}\n`)
  process.exitCode = reply.exitCode ?? 0
} catch (error) {
  // Operational failure is visible but nonblocking; never silently grant permission.
  process.stderr.write(`workbuddy-rsi: ${redact(error.message).slice(0, 300)}\n`)
  process.stdout.write('{}\n')
  process.exitCode = 1
}
