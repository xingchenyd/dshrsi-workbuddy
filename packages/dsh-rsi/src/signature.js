// Stable friction signatures.
//
// A signature names "the same pothole" across sessions: it must survive
// changing paths, line numbers, timestamps and ids, yet keep the fact that
// identifies the cause (which command is missing, which module, which host).

// Order matters: zsh puts the name after the phrase, so its form is tried first.
const COMMAND_NOT_FOUND = [
  /command not found: ([\w.@+-]+)/,
  /(?:^|\n)(?:[\w./-]+: )?(?:line \d+: )?([\w.@+-]+): command not found/,
  /(?:^|\n)sh: \d+: ([\w.@+-]+): not found/,
  /'([\w.@+-]+)' is not recognized as an internal or external command/,
  /The term '([\w.@+-]+)' is not recognized/,
  /spawn ([\w.@+/-]+) ENOENT/,
]

const CLASSIFIERS = [
  { category: 'module-not-found', patterns: [/Cannot find (?:module|package) '([^']+)'/, /ModuleNotFoundError: No module named '([^']+)'/, /Error \[ERR_MODULE_NOT_FOUND\]: Cannot find (?:module|package) '([^']+)'/] },
  { category: 'permission-denied', patterns: [/(?:EACCES|EPERM)[^\n]*?'([^']+)'/, /([^\s:]+): Permission denied/, /Permission denied(?: \(([^)]+)\))?/] },
  { category: 'network', patterns: [/(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN)/, /getaddrinfo ENOTFOUND (\S+)/, /Could not resolve host: (\S+)/, /(?:SSL|TLS)[^\n]*?(certificate[^\n]{0,40})/i, /(proxy)[^\n]*?(?:refused|failed|error)/i] },
  { category: 'port-in-use', verbatim: true, patterns: [/EADDRINUSE[^\n]*?:(\d+)/, /address already in use[^\n]*?:(\d+)/i] },
  { category: 'no-such-file', patterns: [/ENOENT: no such file or directory, \w+ '([^']+)'/, /([^\s:]+): No such file or directory/] },
  { category: 'edit-mismatch', patterns: [/(old_string[^\n]{0,60}(?:not found|not unique|no match|multiple))/i, /(String to replace not found)/i, /(matched \d+ times)/i] },
  { category: 'invalid-arguments', patterns: [/invalid arguments: ([^\n]{0,80})/i] },
  { category: 'timeout', patterns: [/\[still running after (\d+)ms/, /(timed out|timeout exceeded|ETIMEDOUT)/i] },
  { category: 'out-of-memory', patterns: [/(heap out of memory|Killed: 9|MemoryError|ENOMEM)/] },
  { category: 'test-failure', patterns: [/(\d+ (?:failed|failing))/i, /(FAIL(?:ED)?)\b[^\n]{0,60}/, /(AssertionError)/] },
  { category: 'syntax-error', patterns: [/(SyntaxError)[^\n]{0,60}/, /(error TS\d+)/, /(IndentationError)/] },
]

/** Program a "command not found" message names, if the text is one. */
export function missingProgram(text) {
  const source = String(text ?? '')
  for (const pattern of COMMAND_NOT_FOUND) {
    const match = pattern.exec(source)
    if (match) return match[1].replace(/^.*[\\/]/, '')
  }
  return undefined
}

/**
 * Regex source matching `program` where a shell would run it: at the start of the line or after ; & | (,
 * past environment assignments. It does not match the name used as an argument (`command -v program`).
 */
export function commandPositionSource(program) {
  const escaped = String(program).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  return `(?:^|[;&|(]\\s*)(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*${escaped}(?:\\s|$)`
}

/** Whether a command line runs `program`. */
export function runsProgram(command, program) {
  return new RegExp(commandPositionSource(program)).test(String(command ?? ''))
}

/** Reduces volatile detail so equal causes produce equal text. */
export function scrub(text) {
  return String(text)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.@+~-]+){2,}/g, match => `<path>/${match.split(/[\\/]/).at(-1)}`)
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '<time>')
    .replace(/:\d+:\d+\b/g, ':<line>')
    .replace(/\b\d{3,}\b/g, '<n>')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/** First line that reads like a failure, else the first non-empty line. */
export function headline(text) {
  const lines = String(text).split('\n').map(line => line.trim()).filter(line => line && !/^\[(?:stderr|stdout|exit code: \d+)\]$/.test(line))
  const failing = lines.find(line => /error|fail|denied|not found|cannot|unable|refused|invalid|exception|traceback/i.test(line))
  return (failing ?? lines[0] ?? '').slice(0, 160)
}

/** Program a shell command runs first, ignoring env assignments and wrappers. */
export function commandHead(command) {
  const tokens = String(command ?? '').trim().split(/\s+/)
  let index = 0
  while (index < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]) || ['sudo', 'env', 'time', 'nohup', 'exec', 'command'].includes(tokens[index]))) index += 1
  return (tokens[index] ?? '').replace(/^.*[\\/]/, '')
}

/** First two words of a shell command: the unit a user thinks of as "a command". */
export function commandFamily(command) {
  const tokens = String(command ?? '').trim().split(/\s+/)
  let index = 0
  while (index < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]) || ['sudo', 'env', 'time', 'nohup', 'exec', 'command'].includes(tokens[index]))) index += 1
  const head = (tokens[index] ?? '').replace(/^.*[\\/]/, '')
  const sub = tokens[index + 1]
  return sub && /^[a-z][\w:-]*$/i.test(sub) ? `${head} ${sub}` : head
}

/**
 * Classifies failure text.
 * @returns {{ category: string, key: string }} category plus the fact that identifies the cause.
 */
export function classify(text) {
  const source = String(text ?? '')
  const missing = missingProgram(source)
  if (missing !== undefined) return { category: 'command-not-found', key: missing }
  for (const { category, patterns, verbatim } of CLASSIFIERS) {
    for (const pattern of patterns) {
      const match = pattern.exec(source)
      if (match) return { category, key: (verbatim ? match[1] : scrub(match[1] ?? match[0])).slice(0, 80) }
    }
  }
  return { category: 'other', key: scrub(headline(source)).slice(0, 80) }
}

/**
 * Signature of one failed tool observation.
 * @param {{ tool: string, text: string, errorCode?: string }} observation
 */
export function signatureOf(observation) {
  const { category, key } = classify(observation.text)
  if (category === 'other' && observation.errorCode) return `${observation.tool}:${observation.errorCode.toLowerCase()}:${key}`
  return `${observation.tool}:${category}:${key}`
}

/** Deterministic key for tool arguments regardless of property order. */
export function canonicalArgs(value) {
  const sort = input => {
    if (Array.isArray(input)) return input.map(sort)
    if (input !== null && typeof input === 'object') {
      const out = {}
      for (const key of Object.keys(input).sort()) out[key] = sort(input[key])
      return out
    }
    return input
  }
  return JSON.stringify(sort(value))
}
