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
  const reply = await request({ op: 'hook', payload })
  process.stdout.write(`${JSON.stringify(reply.output ?? {})}\n`)
  process.exitCode = reply.exitCode ?? 0
} catch (error) {
  // Operational failure is visible but nonblocking; never silently grant permission.
  process.stderr.write(`workbuddy-rsi: ${redact(error.message).slice(0, 300)}\n`)
  process.stdout.write('{}\n')
  process.exitCode = 1
}
