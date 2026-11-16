import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createWorkBuddyHost } from './host.mjs'
import { MAX_INPUT_BYTES, redact } from './protocol.mjs'
import { resolveHome } from './client.mjs'

export async function startDaemon({ home = resolveHome(), idleMs = 30 * 60 * 1000 } = {}) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  const token = randomBytes(32).toString('hex')
  const host = createWorkBuddyHost({ home })
  const file = path.join(home, 'endpoint.json')
  let queue = Promise.resolve()
  let idle
  let closing = false
  function resetIdle() { clearTimeout(idle); idle = setTimeout(() => shutdown(), idleMs); idle.unref() }
  function shutdown() {
    if (closing) return
    closing = true
    clearTimeout(idle)
    host.dispose()
    try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file) } catch {}
    server.close()
    server.closeIdleConnections?.()
  }
  async function dispatch(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('request must be an object')
    switch (message.op) {
      case 'ping': return { pid: process.pid, protocol: 1 }
      case 'hook': return host.handleHook(message.payload)
      case 'status': return host.status()
      case 'off': return host.setEnabled(false)
      case 'on': return host.setEnabled(true)
      case 'undo': return host.undo() ?? null
      case 'show': return host.show(message.id)
      case 'disable': return host.disable(message.id)
      case 'findings': return host.findings(message.sessionId)
      case 'propose': return host.propose({ source: message.source, sessionId: message.sessionId, signature: message.signature })
      case 'approve': return host.approve(message.id)
      case 'stop': setTimeout(shutdown, 20); return { stopped: true, wasRunning: true }
      default: throw new Error('unknown operation')
    }
  }
  const server = http.createServer((req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${token}`)
    if (req.method !== 'POST' || req.url !== '/rsi' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"error":"forbidden"}'); req.resume(); return
    }
    let bytes = 0
    const chunks = []
    let exceeded = false
    req.on('data', chunk => {
      bytes += chunk.length
      if (bytes > MAX_INPUT_BYTES) {
        if (!exceeded) { exceeded = true; res.writeHead(413, { 'content-type': 'application/json' }); res.end('{"error":"request exceeds 1 MiB"}') }
      } else chunks.push(chunk)
    })
    req.on('end', () => {
      if (exceeded) return
      resetIdle()
      queue = queue.then(async () => {
        try {
          let message
          try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('request must be valid JSON') }
          const result = await dispatch(message)
          const body = JSON.stringify({ result: result ?? null })
          if (Buffer.byteLength(body) > MAX_INPUT_BYTES) throw new Error('response exceeds 1 MiB; narrow the query')
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(body)
        } catch (error) {
          res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: redact(error.message).slice(0, 500) }))
        }
      }).catch(() => {})
    })
  })
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  server.maxConnections = 32
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const endpoint = { protocol: 1, port: server.address().port, token, pid: process.pid, startedAt: new Date().toISOString() }
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(endpoint), { mode: 0o600 })
  fs.renameSync(temporary, file)
  resetIdle()
  return { server, host, endpoint, shutdown }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--home')
  const instance = await startDaemon({ home: resolveHome(i >= 0 ? process.argv[i + 1] : undefined) })
  process.once('SIGTERM', instance.shutdown)
  process.once('SIGINT', instance.shutdown)
}
