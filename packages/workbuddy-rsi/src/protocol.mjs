// WorkBuddy Desktop hook wire format -> the upstream DSHRSI host-neutral API.
import path from 'node:path'
import { describeCall, describeOutcome } from '../../dsh-rsi/src/normalize.js'

export const MAX_INPUT_BYTES = 1024 * 1024
export const EVENTS = Object.freeze(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd'])
const ALIASES = { Bash: 'bash', execute_command: 'bash', bash: 'bash', PowerShell: 'pwsh', Pwsh: 'pwsh', pwsh: 'pwsh', powershell: 'pwsh', Read: 'read', read_file: 'read', read: 'read', Write: 'write', write_to_file: 'write', write: 'write', Edit: 'edit', replace_in_file: 'edit', edit: 'edit', MultiEdit: 'multi_edit', apply_patch: 'apply_patch', Glob: 'glob', Grep: 'grep' }
export const canonicalTool = name => Object.hasOwn(ALIASES, name) ? ALIASES[name] : String(name ?? 'unknown')

/** Best-effort secret minimization, not a guarantee that arbitrary text is secret-free. */
export function redact(text) {
  return String(text ?? '')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[REDACTED]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|secret|password|authorization)\s*[=:]\s*["']?)[^\s"',;}]+/gi, '$1[REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,})\b/g, '[REDACTED]')
}

function clean(value, depth = 0) {
  if (depth > 8) return '[TRUNCATED]'
  if (typeof value === 'string') return redact(value).slice(0, 16000)
  if (Array.isArray(value)) return value.slice(0, 100).map(x => clean(x, depth + 1))
  if (value && typeof value === 'object') {
    const result = Object.create(null)
    for (const [key, entry] of Object.entries(value).slice(0, 100)) {
      result[key] = /^(?:api[_-]?key|token|access[_-]?token|secret|password|authorization)$/i.test(key) ? '[REDACTED]' : clean(entry, depth + 1)
    }
    return result
  }
  return value
}

export function normalizeCall(payload) {
  const tool = canonicalTool(payload.tool_name)
  let raw = payload.tool_input ?? {}
  if (typeof raw === 'string') { try { raw = JSON.parse(raw) } catch { raw = { $raw: raw } } }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('tool_input must be an object')
  const args = clean(raw)
  if (args.command === undefined && typeof args.command_line === 'string') args.command = args.command_line
  if (args.file_path === undefined) args.file_path = args.path ?? args.filePath
  if (args.file_path === undefined) delete args.file_path
  return describeCall(tool, args)
}

function responseText(raw) {
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) return raw.map(responseText).join('\n')
  if (!raw || typeof raw !== 'object') return String(raw ?? '')
  if (typeof raw.text === 'string') return raw.text
  if (raw.content !== undefined) return responseText(raw.content)
  const parts = ['output', 'stdout', 'stderr', 'message', 'error'].filter(key => raw[key] !== undefined).map(key => responseText(raw[key]))
  return parts.length ? parts.join('\n') : JSON.stringify(raw)
}

export function normalizeResult(payload, call = normalizeCall(payload)) {
  const raw = payload.tool_response ?? payload.error ?? ''
  let text = redact(responseText(raw)).slice(0, 24000)
  const code = raw && typeof raw === 'object' ? (raw.exit_code ?? raw.exitCode) : undefined
  const exitCode = Number.isInteger(code) ? code : undefined
  // Native WorkBuddy Bash/PowerShell hooks receive rawResponse, including interrupted
  // commands with a null exitCode. Those are not completed successful executions.
  const interrupted = raw?.interrupted === true || payload.is_interrupt === true
  const signal = typeof raw?.signal === 'string' && raw.signal.trim() ? raw.signal : undefined
  const sandboxDenied = raw?.sandboxDenied === true
  const rawErrorCode = payload.tool_error_code ?? raw?.tool_error_code ?? raw?.toolErrorCode ?? raw?._meta?.tool_error_code
  const errorCode = rawErrorCode === undefined || rawErrorCode === null ? undefined : String(rawErrorCode).slice(0, 128)
  if (exitCode !== undefined && ['bash', 'pwsh'].includes(call.tool)) text += `\n[exit code: ${exitCode}]`
  const isError = payload.hook_event_name === 'PostToolUseFailure' || raw?.isError === true || raw?.is_error === true || raw?.success === false || interrupted || signal !== undefined || sandboxDenied || (exitCode !== undefined && exitCode !== 0)
  const outcome = describeOutcome(call.tool, text, isError, errorCode, call.command)
  return { ...outcome, denied: outcome.denied || sandboxDenied, interrupted, signal, text, bytes: text.length, errorCode }
}

export function normalizeHook(payload, fallbackCwd = process.cwd()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('hook payload must be an object')
  if (!EVENTS.includes(payload.hook_event_name)) throw new Error('unsupported hook_event_name')
  const sessionId = payload.session_id
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) throw new Error('session_id is required (at most 256 characters)')
  if (payload.cwd !== undefined && (typeof payload.cwd !== 'string' || !path.isAbsolute(payload.cwd))) throw new Error('cwd must be an absolute directory')
  const callId = payload.tool_use_id ?? payload.call_id
  if (callId !== undefined && (typeof callId !== 'string' || callId.length > 256)) throw new Error('tool call id must be a string (at most 256 characters)')
  const cwd = typeof payload.cwd === 'string' && path.isAbsolute(payload.cwd) ? path.resolve(payload.cwd) : path.resolve(fallbackCwd)
  return { event: payload.hook_event_name, sessionId, cwd, payload }
}

/** Never emit permissionDecision=allow: upstream permission checks retain authority. */
export function contextOutput(event, notes = [], verdict = {}) {
  const additionalContext = [...new Set(notes.filter(Boolean))].join('\n\n').slice(0, 24000)
  const specific = { hookEventName: event }
  if (additionalContext) specific.additionalContext = additionalContext
  if (event === 'PreToolUse' && (verdict.deny || verdict.ask)) {
    specific.permissionDecision = verdict.deny ? 'deny' : 'ask'
    specific.permissionDecisionReason = verdict.deny ?? verdict.ask
  }
  return Object.keys(specific).length > 1 ? { hookSpecificOutput: specific } : {}
}
