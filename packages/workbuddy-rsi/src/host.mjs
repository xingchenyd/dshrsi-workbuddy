import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createEngine } from '../../dsh-rsi/src/engine.js'
import { openLibrary } from '../../dsh-rsi/src/library.js'
import { validateAdaptation } from '../../dsh-rsi/src/validate.js'
import { createNormalizer } from '../../dsh-rsi/src/normalize.js'
import { createObserver } from '../../dsh-rsi/src/signals.js'
import { normalizeHook, normalizeCall, normalizeResult, contextOutput, redact } from './protocol.mjs'

const ALLOWED = new Set(['annotate', 'steer', 'deny', 'ask', 'verify', 'prompt'])
const safeId = id => { if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('invalid adaptation id'); return id }
const summary = record => ({ id: record.id, title: record.title, status: record.status, version: record.version, capabilities: record.capabilities, scope: record.scope, generator: record.origin?.generator, validation: record.validation })

/** Persistent in-memory host. Library persists; live handler closures reset on daemon restart. */
export function createWorkBuddyHost({ home, options = {} }) {
  if (!path.isAbsolute(home)) throw new Error('home must be absolute')
  const library = openLibrary(path.join(home, 'library'))
  const sessions = new Map()
  const boot = randomUUID().slice(0, 8)
  const warnings = []
  // Deliberately accept only mode; the hook integration cannot grant exec/tool/rewrite/block authority.
  const mode = options.mode ?? 'adapt'
  if (!['adapt', 'observe', 'propose'].includes(mode)) throw new Error('invalid mode')
  const engine = createEngine({ library, options: { mode, generator: 'synth', autonomy: 'tighten', projectHarness: 'off', projectTrust: 'ask', scope: 'workspace', handlerTimeoutMs: 1000, policy: { maxContinuations: 1 } }, host: {
    contribute(_session, mount) {
      if (mount.meta.capabilities.some(capability => !ALLOWED.has(capability))) {
        library.setStatus(mount.id, 'quarantined', 'unsupported capability in WorkBuddy adapter', { by: 'workbuddy-adapter' })
        throw new Error('unsupported capability in WorkBuddy adapter')
      }
    },
    log(level, message) { warnings.push({ level, message: redact(message).slice(0, 500) }); if (warnings.length > 20) warnings.shift() },
  } })

  function getSession(hook) {
    // SessionStart may omit cwd. Once a session has a concrete cwd, do not replace it with a fallback.
    let state = sessions.get(hook.sessionId)
    if (state && hook.payload.cwd && state.cwd !== hook.cwd) { state.session.close(); sessions.delete(hook.sessionId); state = undefined }
    if (!state) {
      if (sessions.size >= 128) { const [oldId, old] = sessions.entries().next().value; old.session.close(); sessions.delete(oldId) }
      state = { cwd: hook.cwd, session: engine.open({ sessionId: `wb:${boot}:${hook.sessionId}`, cwd: hook.cwd }), normalizer: createNormalizer({ sessionId: hook.sessionId, cwd: hook.cwd }), observer: createObserver(), history: [], findings: new Map(), seq: 0, turn: 0, step: 0, active: false, seen: new Set(), sentSections: new Set() }
      sessions.set(hook.sessionId, state)
    }
    return state
  }
  function emit(state, type, data) {
    const event = { type, data, seq: ++state.seq, time: Date.now() }
    state.session.event(event)
    for (const observation of state.normalizer.push(event)) {
      state.history.push(observation)
      if (state.history.length > 400) state.history.shift()
      for (const finding of state.observer.observe(observation)) state.findings.set(finding.signature, finding)
      if (state.findings.size > 100) state.findings.delete(state.findings.keys().next().value)
    }
  }
  function startTurn(state) { state.turn++; state.step = 0; state.active = true; emit(state, 'turn/start', { turn: state.turn }) }
  function sections(state) {
    const notes = []
    for (const mount of state.session.mounted()) for (const section of mount.sections) {
      const key = `${mount.id}:${mount.version}:${section}`
      if (!state.sentSections.has(key)) { state.sentSections.add(key); notes.push(mount.mark(section)) }
    }
    return notes
  }
  async function step(state) { return [...await state.session.beforeStep({ turn: state.turn, step: ++state.step }), ...sections(state)] }

  async function handleHook(payload) {
    const hook = normalizeHook(payload)
    const state = getSession(hook)
    const reply = output => ({ output, exitCode: 0 })
    if (hook.event === 'SessionEnd') { state.session.close(); sessions.delete(hook.sessionId); return reply({}) }
    if (hook.event === 'SessionStart') { state.sentSections.clear(); return reply(contextOutput(hook.event, sections(state))) }
    if (hook.event === 'UserPromptSubmit') {
      startTurn(state)
      emit(state, 'user/message', { content: [{ type: 'text', text: redact(payload.prompt ?? payload.user_prompt ?? '').slice(0, 4000) }], source: { kind: 'user' } })
      return reply(contextOutput(hook.event, await step(state)))
    }
    if (!state.active) startTurn(state)
    if (hook.event === 'PreToolUse') {
      const notes = await step(state)
      const call = normalizeCall(payload)
      const verdict = await state.session.beforeTool(call)
      return reply(contextOutput(hook.event, notes, verdict))
    }
    if (hook.event === 'PostToolUse' || hook.event === 'PostToolUseFailure') {
      const rawId = payload.tool_use_id ?? payload.call_id
      // WorkBuddy can deliver both success/failure hooks for a call; count that observation once.
      const eventKey = rawId === undefined ? undefined : `${state.turn}:${String(rawId)}`
      if (eventKey && state.seen.has(eventKey)) return reply({})
      if (eventKey) { state.seen.add(eventKey); if (state.seen.size > 2000) state.seen.delete(state.seen.values().next().value) }
      const call = normalizeCall(payload)
      const result = normalizeResult(payload, call)
      const outcome = await state.session.afterTool(call, result)
      const callId = String(rawId ?? `wb-call-${state.seq + 1}`)
      emit(state, 'tool/call', { turn: state.turn, step: state.step, callId, name: call.tool, arguments: JSON.stringify(call.args) })
      emit(state, 'tool/result', { turn: state.turn, step: state.step, message: { toolCallId: callId, content: [{ type: 'text', text: result.text }], isError: !result.ok }, error: result.errorCode ? { code: result.errorCode } : undefined })
      const notes = [...outcome.notes, ...await step(state)]
      // No result rewriting or block: unsupported capabilities are rejected on contribution/proposal.
      return reply(contextOutput(hook.event, notes))
    }
    if (hook.event === 'Stop') {
      if (payload.stop_hook_active !== true) {
        for (const finding of state.observer.probeStop({ turn: state.turn, step: state.step, seq: state.seq })) state.findings.set(finding.signature, finding)
        const reason = await state.session.beforeStop({ turn: state.turn })
        if (reason) return reply({ decision: 'block', reason })
      }
      emit(state, 'turn/end', { turn: state.turn, reason: { kind: 'completed' } })
      state.active = false
      return reply({})
    }
    return reply({})
  }

  function show(id) { const record = library.get(safeId(id)); if (!record) throw new Error('adaptation not found'); return { ...record, source: library.readSource(id) } }
  async function propose({ source, sessionId, signature }) {
    if (typeof source !== 'string' || source.length > 20000) throw new Error('source must be at most 20000 characters')
    const state = sessions.get(sessionId)
    const finding = state?.findings.get(signature)
    if (!finding || !finding.evidence?.length) throw new Error('proposal requires a finding recorded in this live WorkBuddy session')
    const { history, cwd } = state
    const validation = await validateAdaptation({ source, finding, history, autonomy: 'tighten', env: { cwd, platform: process.platform } })
    if (!validation.ok) return { ok: false, validation }
    const unsupported = validation.meta.capabilities.filter(capability => !ALLOWED.has(capability))
    if (unsupported.length) return { ok: false, problems: [`unsupported WorkBuddy capabilities: ${unsupported.join(', ')}`] }
    const record = library.create({ title: validation.meta.title, description: validation.meta.description, capabilities: validation.meta.capabilities, tier: 'tighten', status: 'proposed', validation: validation.report, layer: 'project', scope: { kind: 'workspace', cwd: path.resolve(cwd) }, friction: { kind: finding.kind ?? 'user-proposal', signature: finding.signature, summary: finding.summary ?? validation.meta.description }, origin: { generator: 'workbuddy-submitted', sessionId, evidence: finding.evidence, validationContext: { finding, history: [...history] } } }, source, { by: 'workbuddy-proposal' })
    return { ok: true, record: summary(record) }
  }
  async function approve(id) {
    const record = show(id)
    if (record.capabilities.some(capability => !ALLOWED.has(capability))) throw new Error('unsupported capability')
    if (record.origin?.validationContext) {
      const validation = await validateAdaptation({ source: record.source, ...record.origin.validationContext, autonomy: 'tighten', env: { cwd: record.scope.cwd, platform: process.platform } })
      if (!validation.ok || validation.meta.capabilities.some(capability => !ALLOWED.has(capability))) throw new Error('proposal no longer passes validation')
    }
    library.approve(id, { by: 'user' }); engine.sync(); return { ...summary(library.get(id)), activation: 'next-session' }
  }
  return {
    handleHook, library, engine, propose, approve, show,
    findings: sessionId => { const state = sessions.get(sessionId); if (!state) throw new Error('live session not found'); return { sessionId, cwd: state.cwd, findings: [...state.findings.values()], history: [...state.history] } },
    status: () => ({ enabled: !engine.stock(), mode, liveSessions: sessions.size, sessions: [...sessions].map(([sessionId, state]) => ({ sessionId, cwd: state.cwd })), generator: 'synth', unsupportedCapabilities: ['block', 'rewrite', 'tool', 'exec'], records: library.list().map(summary), warnings: [...warnings], restartBehavior: 'Persistent adaptations are retained; in-flight session observations and handler counters reset when the helper restarts.' }),
    setEnabled: enabled => { if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean'); engine.setStock(!enabled); if (enabled) for (const state of sessions.values()) state.sentSections.clear(); return { enabled } },
    undo: () => engine.undo(),
    disable: id => { safeId(id); library.setStatus(id, 'disabled', 'disabled by user', { by: 'user' }); engine.sync(); return summary(library.get(id)) },
    dispose: () => { engine.dispose(); sessions.clear() },
  }
}
