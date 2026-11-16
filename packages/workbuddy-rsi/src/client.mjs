import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { MAX_INPUT_BYTES } from './protocol.mjs'

export const resolveHome = home => path.resolve(home ?? process.env.WB_RSI_HOME ?? path.join(os.homedir(), '.workbuddy-rsi'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const endpointFile = home => path.join(home, 'endpoint.json')

export function readEndpoint(home) {
  try {
    const endpoint = JSON.parse(fs.readFileSync(endpointFile(home), 'utf8'))
    if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || !/^[a-f0-9]{64}$/.test(endpoint.token) || !Number.isInteger(endpoint.pid)) return undefined
    return endpoint
  } catch { return undefined }
}

export function callEndpoint(endpoint, payload, { timeoutMs = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    if (Buffer.byteLength(body) > MAX_INPUT_BYTES) return reject(new Error('request exceeds 1 MiB'))
    const req = http.request({ host: '127.0.0.1', port: endpoint.port, path: '/rsi', method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: `Bearer ${endpoint.token}` }, timeout: timeoutMs }, res => {
      let bytes = 0
      const parts = []
      res.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_INPUT_BYTES) { res.destroy(); reject(new Error('response exceeds 1 MiB')) } else parts.push(chunk) })
      res.on('error', reject)
      res.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(parts).toString('utf8'))
          if (res.statusCode !== 200 || value.error) reject(new Error(value.error ?? `helper returned HTTP ${res.statusCode}`))
          else resolve(value.result)
        } catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('helper request timed out')))
    req.end(body)
  })
}

async function running(home) {
  const endpoint = readEndpoint(home)
  if (!endpoint) return undefined
  try { await callEndpoint(endpoint, { op: 'ping' }, { timeoutMs: 500 }); return endpoint } catch { return undefined }
}

async function ensureStarted(home) {
  const live = await running(home)
  if (live) return live
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  const lock = path.join(home, 'startup.lock')
  const until = Date.now() + 15000
  let descriptor
  while (Date.now() < until) {
    const started = await running(home)
    if (started) return started
    try { descriptor = fs.openSync(lock, 'wx', 0o600); fs.writeFileSync(descriptor, String(process.pid)); break } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 20000) fs.unlinkSync(lock) } catch {}
      await pause(80)
    }
  }
  if (descriptor === undefined) throw new Error('timed out waiting for helper startup lock')
  try {
    const started = await running(home)
    if (started) return started
    // Only our exact endpoint path is removed; no process is killed based on a stale PID.
    try { fs.unlinkSync(endpointFile(home)) } catch (error) { if (error.code !== 'ENOENT') throw error }
    // A persistent helper must not hold a Windows cwd handle on the invoking
    // workspace (which may be renamed or removed as soon as the hook returns).
    const child = spawn(process.execPath, [fileURLToPath(new URL('./daemon.mjs', import.meta.url)), '--home', home], { cwd: home, detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, WB_RSI_HOME: home } })
    let failure
    child.on('error', error => { failure = error })
    child.unref()
    for (let tries = 0; tries < 100; tries++) {
      if (failure) throw failure
      const ready = await running(home)
      if (ready) return ready
      await pause(60)
    }
    throw new Error('helper did not become ready; check Node.js and the installation path')
  } finally { fs.closeSync(descriptor); try { fs.unlinkSync(lock) } catch {} }
}

async function waitForStopped(home, endpoint, timeoutMs) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    let authenticated = false
    try { await callEndpoint(endpoint, { op: 'ping' }, { timeoutMs: Math.min(250, Math.max(1, until - Date.now())) }); authenticated = true } catch {}
    // The daemon removes its own endpoint only after the HTTP listener closes.
    // Compare tokens so a concurrent, newly started helper is never stopped here.
    if (!authenticated && readEndpoint(home)?.token !== endpoint.token) return
    await pause(25)
  }
  throw new Error('helper did not finish stopping within the timeout')
}

/** Authenticated local-only IPC. No WorkBuddy credentials or transcript access is needed. */
export async function request(payload, { home, timeoutMs } = {}) {
  const directory = resolveHome(home)
  if (payload?.op === 'stop') {
    const endpoint = await running(directory)
    if (!endpoint) return { stopped: true, wasRunning: false }
    const result = await callEndpoint(endpoint, payload, { timeoutMs })
    await waitForStopped(directory, endpoint, Math.min(timeoutMs ?? 5000, 15000))
    return result
  }
  const endpoint = await ensureStarted(directory)
  // Never retry a possibly completed mutation after a timeout.
  return callEndpoint(endpoint, payload, { timeoutMs })
}
