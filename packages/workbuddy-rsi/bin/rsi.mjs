#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { request } from '../src/client.mjs'

const help = `DSHRSI for WorkBuddy 0.1.0
Usage: node rsi.mjs <command> [arguments] [--home ABSOLUTE_DIRECTORY]

status                    Inspect enabled state and learned adaptations
findings SESSION_ID       Inspect actual live-session evidence for a proposal
show ID                   Read one adaptation, source and validation report
propose FILE SESSION_ID SIGNATURE
                          Replay WorkBuddy-written code against observed evidence
approve ID                Enable a validated proposal for the next session
disable ID                Disable one adaptation
off | on                  Disable or re-enable all RSI behavior
undo                      Undo the latest adaptation change
stop                      Stop the local helper (hooks restart it on demand)

WB_RSI_HOME overrides the local state directory. No API key is required.
propose never activates code; inspect the report before requesting approve.
`
try {
  const args = process.argv.slice(2)
  let home
  const homeAt = args.indexOf('--home')
  if (homeAt >= 0) { home = args[homeAt + 1]; if (!home || !path.isAbsolute(home)) throw new Error('--home requires an absolute directory'); args.splice(homeAt, 2) }
  const [command, ...values] = args
  if (!command || ['--help', '-h', 'help'].includes(command)) console.log(help)
  else {
    let payload
    if (['status', 'off', 'on', 'undo', 'stop'].includes(command) && values.length === 0) payload = { op: command }
    else if (['show', 'disable', 'approve'].includes(command) && values.length === 1) payload = { op: command, id: values[0] }
    else if (command === 'findings' && values.length === 1) payload = { op: command, sessionId: values[0] }
    else if (command === 'propose' && values.length === 3) {
      const file = path.resolve(values[0]); const stat = fs.statSync(file)
      if (!stat.isFile() || stat.size > 80000) throw new Error('proposal source must be a file smaller than 80 KB')
      payload = { op: command, source: fs.readFileSync(file, 'utf8'), sessionId: values[1], signature: values[2] }
    } else throw new Error('Invalid arguments. Run with --help.')
    const result = await request(payload, { ...(home ? { home } : {}) })
    console.log(JSON.stringify(result, null, 2))
    if (result?.ok === false) process.exitCode = 1
  }
} catch (error) {
  console.error(`workbuddy-rsi: ${error.message}`)
  process.exitCode = 1
}
