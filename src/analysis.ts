// Static analysis without a parser: symbols, calls, routes and topics read off
// source text with patterns per language family. Every result carries the line
// it came from, so whatever is shown can be checked against the file.

import { summarizeDiff, unifiedDiff } from './diff'

export type Lang = 'js' | 'py' | 'go' | 'rb' | 'other'

export type SymbolKind = 'function' | 'method' | 'class' | 'component' | 'route' | 'handler'

export type CodeSymbol = {
  name: string
  kind: SymbolKind
  path: string
  line: number
  endLine: number
  /** For a route: the handler names it passes, in order. */
  handlers?: string[]
  /** For a route: METHOD and URL. */
  method?: string
  url?: string
  isAsync?: boolean
  isExported?: boolean
}

export function langOf(path: string): Lang {
  if (/\.(m|c)?(j|t)sx?$/i.test(path) || /\.(vue|svelte)$/i.test(path)) return 'js'
  if (/\.py$/i.test(path)) return 'py'
  if (/\.go$/i.test(path)) return 'go'
  if (/\.rb$/i.test(path)) return 'rb'
  return 'other'
}

export function isSourceFile(path: string): boolean {
  return langOf(path) !== 'other'
}

const JS_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new', 'await',
  'async', 'yield', 'delete', 'void', 'in', 'of', 'do', 'else', 'try', 'throw', 'class',
  'super', 'this', 'import', 'export', 'const', 'let', 'var', 'case', 'default', 'with',
  'def', 'elif', 'lambda', 'print', 'not', 'and', 'or', 'is', 'func', 'go', 'defer', 'range',
  'constructor', 'require', 'console', 'get', 'set', 'static',
])

export function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Line number (1-based) of character offset `index` in `text`. */
export function lineAt(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

/**
 * `text` with the insides of string literals and comments blanked out, same
 * length and same lines, so patterns looking for code never match text that
 * only quotes code (a test asserting on `'function f() {'`, a commented-out
 * route). Quotes stay; a quote or regex literal left open ends at its line.
 */
export function maskCode(text: string, lang: Lang): string {
  const out = text.split('')
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '
  }
  const hashComments = lang === 'py' || lang === 'rb'
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    const next = text[i + 1]
    if (!hashComments && ch === '/' && next === '/') {
      const end = text.indexOf('\n', i)
      blank(i, end < 0 ? text.length : end)
      i = end < 0 ? text.length : end
    } else if (!hashComments && ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      blank(i, end < 0 ? text.length : end + 2)
      i = end < 0 ? text.length : end + 2
    } else if (hashComments && ch === '#') {
      const end = text.indexOf('\n', i)
      blank(i, end < 0 ? text.length : end)
      i = end < 0 ? text.length : end
    } else if (lang === 'js' && ch === '/' && next !== '>' && /[(,=:[!&|?{;]\s*$|^\s*$|\breturn\s*$/.test(text.slice(Math.max(0, text.lastIndexOf('\n', i - 1) + 1), i))) {
      // (`/>` closes a JSX tag; after `}` a slash is division or a tag, rarely a regex.)
      // A regex literal: up to its closing slash, outside character classes.
      let k = i + 1
      let inClass = false
      while (k < text.length && text[k] !== '\n') {
        if (text[k] === '\\') k++
        else if (text[k] === '[') inClass = true
        else if (text[k] === ']') inClass = false
        else if (text[k] === '/' && !inClass) break
        k++
      }
      blank(i + 1, Math.min(k, text.length))
      i = k + 1
    } else if (ch === '"' || ch === "'" || ch === '`') {
      const triple = lang === 'py' && text.startsWith(ch.repeat(3), i)
      const close = triple ? ch.repeat(3) : ch
      const multiline = triple || ch === '`'
      let k = i + close.length
      while (k < text.length) {
        if (text[k] === '\\') { k += 2; continue }
        if (text.startsWith(close, k)) break
        if (text[k] === '\n' && !multiline) break
        k++
      }
      blank(i + close.length, Math.min(k, text.length))
      i = text.startsWith(close, k) ? k + close.length : k
    } else {
      i++
    }
  }
  return out.join('')
}

/**
 * The last line of a brace-delimited block starting on `startLine`, skipping
 * braces inside strings and comments well enough for ordinary code.
 */
export function braceEnd(lines: readonly string[], startLine: number): number {
  let depth = 0
  let parens = 0
  let opened = false
  for (let i = startLine - 1; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    const line = raw.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""').replace(/\/\/.*$/, '')
    let closed = false
    for (const ch of line) {
      // Braces inside the parameter list (destructuring, defaults) are not the body.
      if (ch === '(') parens++
      else if (ch === ')') parens = Math.max(0, parens - 1)
      if (parens > 0 && !opened) continue
      if (ch === '{') {
        depth++
        opened = true
        closed = false
      } else if (ch === '}') {
        depth--
        // On the first line a closed brace may be a type (`(): { a: T } {`): the body can still open after it.
        if (opened && depth <= 0) {
          if (i > startLine - 1) return i + 1
          closed = true
        }
      }
    }
    if (closed) return i + 1
    // An arrow function with an expression body ends where its statement ends.
    if (!opened && i > startLine - 1 + 2) return i
    if (!opened && /;\s*$/.test(line) && i >= startLine - 1) return i + 1
  }
  return Math.min(lines.length, startLine + 40)
}

/** The last line of an indentation-delimited Python block. */
export function indentEnd(lines: readonly string[], startLine: number): number {
  const head = lines[startLine - 1] ?? ''
  const base = head.length - head.trimStart().length
  let last = startLine
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    if (indent <= base) break
    last = i + 1
  }
  return last
}

type Pattern = { re: RegExp; kind: SymbolKind; nameGroup: number }

const JS_PATTERNS: Pattern[] = [
  { re: /^[ \t]*(export\s+(default\s+)?)?(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm, kind: 'function', nameGroup: 4 },
  { re: /^[ \t]*(export\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)\s*(:[^=\n]+)?=\s*(async\s+)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*(:[^=\n]+)?=>/gm, kind: 'function', nameGroup: 3 },
  { re: /^[ \t]*(export\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(async\s+)?function\b/gm, kind: 'function', nameGroup: 3 },
  { re: /^[ \t]*(export\s+(default\s+)?)?(abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm, kind: 'class', nameGroup: 4 },
  { re: /^[ \t]+(public\s+|private\s+|protected\s+|static\s+)*(async\s+)?([A-Za-z_$][\w$]*)\s*\([^)\n]*\)\s*(:[^{\n]+)?\{/gm, kind: 'method', nameGroup: 3 },
]

const PY_PATTERNS: Pattern[] = [
  { re: /^[ \t]*(async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm, kind: 'function', nameGroup: 2 },
  { re: /^[ \t]*class\s+([A-Za-z_]\w*)/gm, kind: 'class', nameGroup: 1 },
]

const GO_PATTERNS: Pattern[] = [
  { re: /^func\s+(\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/gm, kind: 'function', nameGroup: 2 },
]

const RB_PATTERNS: Pattern[] = [
  { re: /^[ \t]*def\s+(self\.)?([A-Za-z_]\w*[?!]?)/gm, kind: 'function', nameGroup: 2 },
  { re: /^[ \t]*class\s+([A-Z]\w*)/gm, kind: 'class', nameGroup: 1 },
]

const ROUTE_RE =
  /\b(app|router|server|api|route|r)\s*\.\s*(get|post|put|patch|delete|all|use)\s*\(\s*(["'`])([^"'`]+)\3\s*,?([^;\n]*)/gi
const PY_ROUTE_RE = /^[ \t]*@(\w+)\.(route|get|post|put|patch|delete)\(\s*["']([^"']+)["']([^)]*)\)/gim

/** Every function, class, method, component and route the text defines. */
export function extractSymbols(text: string, path: string): CodeSymbol[] {
  const lang = langOf(path)
  if (lang === 'other') return []
  // Patterns read code only: what strings and comments say is not a definition.
  const masked = maskCode(text, lang)
  const lines = masked.split('\n')
  const out: CodeSymbol[] = []
  const seen = new Set<string>()
  const patterns =
    lang === 'js' ? JS_PATTERNS : lang === 'py' ? PY_PATTERNS : lang === 'go' ? GO_PATTERNS : RB_PATTERNS
  for (const { re, kind, nameGroup } of patterns) {
    re.lastIndex = 0
    for (let m = re.exec(masked); m !== null; m = re.exec(masked)) {
      const name = m[nameGroup]
      if (name === undefined || JS_KEYWORDS.has(name)) continue
      const line = lineAt(masked, m.index + (m[0].length - m[0].trimStart().length))
      const key = `${name}:${line}`
      if (seen.has(key)) continue
      // A "method" match on a line some other pattern already took is that symbol.
      if (kind === 'method' && out.some(s => s.line === line)) continue
      if (kind === 'method' && /^\s*(if|for|while|switch|catch|return|else)\b/.test(lines[line - 1] ?? '')) continue
      seen.add(key)
      const endLine = lang === 'py' ? indentEnd(lines, line) : lang === 'rb' ? rubyEnd(lines, line) : braceEnd(lines, line)
      const head = m[0]
      const isComponent = lang === 'js' && /^[A-Z]/.test(name) && !/^[A-Z0-9_]+$/.test(name) && kind !== 'class' && /\.(j|t)sx$/i.test(path)
      out.push({
        name,
        kind: isComponent ? 'component' : kind,
        path,
        line,
        endLine: Math.max(line, endLine),
        isAsync: /\basync\b/.test(head),
        isExported: /\bexport\b/.test(head) || new RegExp(`exports\\.${escapeRe(name)}\\b|export\\s*\\{[^}]*\\b${escapeRe(name)}\\b|module\\.exports\\s*=\\s*\\{[^}]*\\b${escapeRe(name)}\\b`).test(text),
      })
    }
  }
  for (const route of extractRoutes(text, path, masked)) out.push(route)
  return out.sort((a, b) => a.line - b.line)
}

function rubyEnd(lines: readonly string[], startLine: number): number {
  const head = lines[startLine - 1] ?? ''
  const base = head.length - head.trimStart().length
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (/^\s*end\b/.test(line) && line.length - line.trimStart().length === base) return i + 1
  }
  return Math.min(lines.length, startLine + 30)
}

export function extractRoutes(text: string, path: string, masked = maskCode(text, langOf(path))): CodeSymbol[] {
  const out: CodeSymbol[] = []
  const lang = langOf(path)
  const re = lang === 'py' ? PY_ROUTE_RE : ROUTE_RE
  re.lastIndex = 0
  const lines = masked.split('\n')
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    // A route quoted in a string or written in a comment registers nothing.
    const at = m.index + (m[0].length - m[0].trimStart().length)
    if (masked[at] !== text[at]) continue
    const method = (lang === 'py' ? (m[2] === 'route' ? 'ANY' : m[2]) : m[2])?.toUpperCase() ?? 'ANY'
    const url = (lang === 'py' ? m[3] : m[4]) ?? ''
    if (!url.startsWith('/')) continue
    // The handlers, read from code only (a trailing comment names none).
    const rest = lang === 'py' ? '' : masked.slice(m.index + m[0].length - (m[5] ?? '').length, m.index + m[0].length)
    const handlers = [...rest.matchAll(/([A-Za-z_$][\w$.]*)/g)]
      .map(h => (h[1] ?? '').split('.').pop() ?? '')
      .filter(h => h !== '' && !JS_KEYWORDS.has(h) && !/^(req|res|next|async|ctx)$/.test(h))
    const line = lineAt(text, m.index)
    let handlerNames = handlers
    let endLine = line
    if (lang === 'py') {
      // The decorated function on the following lines is the handler.
      for (let i = line; i < Math.min(lines.length, line + 4); i++) {
        const def = /^\s*(async\s+)?def\s+(\w+)/.exec(lines[i] ?? '')
        if (def?.[2] !== undefined) {
          handlerNames = [def[2]]
          endLine = indentEnd(lines, i + 1)
          break
        }
      }
    } else {
      endLine = /=>|function/.test(rest) ? braceEnd(lines, line) : line
    }
    out.push({
      name: `${method} ${url}`,
      kind: 'route',
      path,
      line,
      endLine,
      method,
      url,
      handlers: handlerNames,
    })
  }
  return out
}

export type CallSite = {
  name: string
  line: number
  kind: 'call' | 'callback' | 'http' | 'render'
  /** For `a.b()`: `a`. */
  receiver?: string
  url?: string
  method?: string
}

/**
 * Calls made in `body` (whose first line is `firstLine`): plain calls,
 * functions handed over as callbacks or event handlers, JSX components
 * rendered, and HTTP requests to literal URLs.
 */
export function findCalls(body: string, firstLine: number): CallSite[] {
  const out: CallSite[] = []
  const lines = body.split('\n')
  lines.forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$/, '').replace(/#.*$/, '')
    const at = firstLine + i
    for (const m of line.matchAll(/(?<![\w$.])(?:this\.|self\.|await\s+)?([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[1]
      if (name !== undefined && !JS_KEYWORDS.has(name)) out.push({ name, line: at, kind: 'call' })
    }
    for (const m of line.matchAll(/([A-Za-z_$][\w$]*)?(?:\(\))?\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[2]
      if (name !== undefined && !JS_KEYWORDS.has(name)) out.push({ name, line: at, kind: 'call', receiver: m[1] })
    }
    for (const m of line.matchAll(/\bon[A-Z]\w*\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*\}/g)) {
      if (m[1] !== undefined) out.push({ name: m[1], line: at, kind: 'callback' })
    }
    for (const m of line.matchAll(/addEventListener\(\s*["'`]\w+["'`]\s*,\s*([A-Za-z_$][\w$]*)/g)) {
      if (m[1] !== undefined) out.push({ name: m[1], line: at, kind: 'callback' })
    }
    for (const m of line.matchAll(/<([A-Z][\w$]*)[\s/>]/g)) {
      if (m[1] !== undefined) out.push({ name: m[1], line: at, kind: 'render' })
    }
    const http =
      /\b(fetch|axios\.(get|post|put|patch|delete)|request|http\.(get|post)|requests\.(get|post|put|patch|delete))\s*\(\s*(["'`])([^"'`$]*)/.exec(line)
    if (http !== null) {
      const url = (http[6] ?? '').replace(/^https?:\/\/[^/]+/, '')
      const verb = (http[2] ?? http[3] ?? http[4] ?? '').toUpperCase()
      const methodInOptions = /method\s*:\s*["'`](\w+)/i.exec(lines.slice(i, i + 4).join(' '))?.[1]?.toUpperCase()
      if (url.startsWith('/')) out.push({ name: url, line: at, kind: 'http', url, method: verb || methodInOptions || 'GET' })
    }
  })
  return out
}

// ---------------------------------------------------------------------------
// Topics: what a piece of code is about, read off its words.

export const TOPICS: Record<string, RegExp> = {
  // Whole words only: "author" is not auth, a "session" or "token" count is not sign-in, `hash(text)` is not security.
  authentication: /\b(auth(entic\w*|ori[sz]\w*|n|z)?|login|logout|sign[_-]?in|jwt|token|password\w*|bcrypt|argon2?|oauth|credentials?|cookies?|session[_-]?id)\b|[a-z](password|login|logout|jwt|oauth|credential)/i,
  security: /\b(csrf|xss|sanitiz\w*|encrypt\w*|decrypt\w*|permissions?|acl|secrets?|cors|hmac|crypto)\b/i,
  database: /\b(db|database|sql|transaction|prisma|sequelize|mongoose|knex|findOne|findMany|migrations?|insert into|delete from|select\s+[\w*, ]+\s+from)\b|\bupdate\s+\w+\s+set\b|\.query\(/i,
  api: /\b(router|route|endpoint|app\.(get|post|put|delete|patch)|fetch|axios|request|response|res\.(json|send|status)|express|fastapi|handler|middleware)\b/i,
  async: /\b(async|await|promise|then\(|callback|setTimeout|setInterval|asyncio|goroutine|channel)\b/i,
  'error handling': /\b(try|catch|throw|raise|except|error|reject|finally)\b/i,
  'react state': /\b(useState|useEffect|useReducer|useContext|setState|props|component)\b/i,
  testing: /\b(describe|it\(|test\(|expect|assert|mock|jest|vitest|pytest)\b/i,
  configuration: /\b(config|settings|env|process\.env|os\.environ|dotenv)\b/i,
  dependencies: /\b(dependencies|devDependencies|require\(|import\s.+\sfrom|pip|requirements)\b/i,
  validation: /\b(validat\w*|schema|zod|joi|yup|pydantic|required|isEmail)\b/i,
  caching: /\b(cache|memo\w*|redis|ttl|lru)\b/i,
}

const TOPIC_WORDS: Record<string, string[]> = {
  authentication: ['auth', 'login', 'jwt', 'token', 'session', 'password', 'sign in', 'identity'],
  security: ['security', 'secure', 'permission', 'encrypt', 'hash'],
  database: ['database', 'db', 'query', 'queries', 'sql', 'data', 'store', 'persist', 'model'],
  api: ['api', 'endpoint', 'route', 'http', 'request', 'server', 'backend'],
  async: ['async', 'await', 'promise', 'concurrency'],
  'error handling': ['error', 'exception', 'failure', 'fail'],
  'react state': ['react', 'state', 'hook', 'component', 'frontend', 'ui'],
  testing: ['test', 'testing', 'spec'],
  configuration: ['config', 'configuration', 'environment', 'settings'],
  dependencies: ['dependency', 'dependencies', 'package', 'library'],
  validation: ['validation', 'validate', 'input'],
  caching: ['cache', 'caching', 'memo'],
}

export function topicsOf(text: string): string[] {
  return Object.entries(TOPICS)
    .filter(([, re]) => re.test(text))
    .map(([name]) => name)
}

/** The topics a free-text focus such as "only database queries" names. */
export function topicsInFocus(focus: string): string[] {
  const f = focus.toLowerCase()
  return Object.entries(TOPIC_WORDS)
    .filter(([name, words]) => f.includes(name) || words.some(w => new RegExp(`\\b${w}`).test(f)))
    .map(([name]) => name)
}

/** Words of a focus that are worth matching literally in code. */
export function focusTerms(focus: string): string[] {
  const stop = new Set(['only', 'just', 'tell', 'me', 'about', 'explain', 'show', 'the', 'and', 'how', 'what', 'with', 'for', 'changes', 'code', 'of', 'to', 'in', 'a', 'an', 'is', 'are', 'my'])
  return focus
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(w => w.length > 2 && !stop.has(w))
}

// ---------------------------------------------------------------------------
// Changes: what an edit batch did, and whether it is worth a card.

export type FileChange = {
  path: string
  /** File text before the batch; null when the batch created the file. */
  before: string | null
  /** File text after the batch; '' when the batch deleted the file, null when unreadable. */
  after: string | null
  /** Edit snippets when whole-file text is unavailable. */
  snippets: { old: string; new: string }[]
  tools: string[]
  at: number
}

export type ChangeAnalysis = {
  path: string
  isNew: boolean
  added: CodeSymbol[]
  removed: string[]
  modified: CodeSymbol[]
  addedLines: number
  removedLines: number
  topics: string[]
  /** New-side line ranges the change touches, as [first, last]; empty when only edit snippets are known. */
  ranges: [number, number][]
  newImports: string[]
  isTrivial: boolean
  reasons: string[]
  score: number
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*(\/\/|#).*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function body(text: string, s: CodeSymbol): string {
  return text.split('\n').slice(s.line - 1, s.endLine).join('\n')
}

/** Identifiers a file imports, mapped to the module they come from. */
export function importBindings(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of text.matchAll(/import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g)) {
    const clause = m[1] ?? ''
    const mod = m[2] ?? ''
    for (const id of clause.replace(/[{}*]/g, ' ').replace(/\bas\b/g, ' ').split(/[\s,]+/)) {
      if (/^[A-Za-z_$][\w$]*$/.test(id) && id !== 'type') out.set(id, mod)
    }
  }
  for (const m of text.matchAll(/(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g)) {
    const mod = m[2] ?? ''
    for (const id of (m[1] ?? '').replace(/[{}]/g, ' ').split(/[\s,:]+/)) {
      if (/^[A-Za-z_$][\w$]*$/.test(id)) out.set(id, mod)
    }
  }
  for (const m of text.matchAll(/^\s*from\s+([\w.]+)\s+import\s+([\w, ]+)/gm)) {
    for (const id of (m[2] ?? '').split(/[\s,]+/)) if (id !== '' && id !== 'as') out.set(id, m[1] ?? '')
  }
  for (const m of text.matchAll(/^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?\s*$/gm)) {
    const id = m[2] ?? (m[1] ?? '').split('.')[0] ?? ''
    if (id !== '') out.set(id, m[1] ?? '')
  }
  return out
}

function importsOf(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/(?:from\s+["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)|^\s*import\s+([\w.]+)|^\s*from\s+([\w.]+)\s+import)/gm)) {
    const name = m[1] ?? m[2] ?? m[3] ?? m[4]
    if (name !== undefined) out.add(name)
  }
  return [...out]
}

function depsOf(packageJson: string): string[] {
  try {
    const parsed = JSON.parse(packageJson) as Record<string, unknown>
    const names: string[] = []
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const block = parsed[key]
      if (block !== null && typeof block === 'object') names.push(...Object.keys(block))
    }
    return names
  } catch {
    return []
  }
}

/** Counts lines added and removed between two texts (multiset difference). */
export function lineDelta(before: string, after: string): { added: number; removed: number } {
  const count = new Map<string, number>()
  for (const l of before.split('\n')) if (l.trim() !== '') count.set(l.trim(), (count.get(l.trim()) ?? 0) + 1)
  let added = 0
  for (const l of after.split('\n')) {
    const t = l.trim()
    if (t === '') continue
    const n = count.get(t) ?? 0
    if (n > 0) count.set(t, n - 1)
    else added++
  }
  let removed = 0
  for (const n of count.values()) removed += n
  return { added, removed }
}

export function analyzeChange(change: FileChange): ChangeAnalysis {
  const before = change.before ?? change.snippets.map(s => s.old).join('\n')
  const after = change.after ?? change.snippets.map(s => s.new).join('\n')
  const isNew = change.before === null && change.snippets.length === 0
  const beforeSyms = extractSymbols(before, change.path)
  const afterSyms = extractSymbols(after, change.path)
  const beforeNames = new Map(beforeSyms.map(s => [s.name, s]))
  const afterNames = new Set(afterSyms.map(s => s.name))
  const added = afterSyms.filter(s => !beforeNames.has(s.name))
  const removed = beforeSyms.filter(s => !afterNames.has(s.name)).map(s => s.name)
  const changedSyms = afterSyms.filter(s => {
    const old = beforeNames.get(s.name)
    return old !== undefined && stripComments(body(before, old)) !== stripComments(body(after, s))
  })
  const ranges = change.after !== null ? (summarizeDiff(`--- a/f\n+++ b/f\n${unifiedDiff(before, after, 0)}`)[0]?.ranges ?? []) : []
  // A class (or any symbol) changed only inside its changed methods is not itself what changed.
  const inner = (s: CodeSymbol) => [...added, ...changedSyms].filter(t => t !== s && t.kind !== 'route' && t.line >= s.line && t.endLine <= s.endLine && t.endLine - t.line < s.endLine - s.line)
  const modified = changedSyms.filter(s => {
    const parts = inner(s)
    if (parts.length === 0) return true
    if (ranges.length === 0) return false
    return ranges.some(([a, b]) => {
      for (let l = Math.max(a, s.line); l <= Math.min(b, s.endLine); l++) if (!parts.some(t => t.line <= l && l <= t.endLine)) return true
      return false
    })
  })
  const { added: addedLines, removed: removedLines } = lineDelta(before, after)
  // Topics come from the lines that changed, not from everything around them.
  const afterLines = after.split('\n')
  const changedText = isNew
    ? after
    : ranges.length > 0
      ? ranges.map(([a, b]) => afterLines.slice(a - 1, b).join('\n')).join('\n')
      : [...added, ...modified].map(s => body(after, s)).join('\n') + '\n' + change.snippets.map(s => s.new).join('\n')
  const topics = topicsOf(changedText + ' ' + change.path)
  const beforeImports = new Set(importsOf(before))
  let newImports = importsOf(after).filter(i => !beforeImports.has(i))
  if (/(^|\/)package\.json$/.test(change.path)) {
    const had = new Set(depsOf(before))
    newImports = depsOf(after).filter(d => !had.has(d))
  }
  const isTrivial = stripComments(before) === stripComments(after)

  const reasons: string[] = []
  let score = 0
  if (isTrivial) {
    reasons.push('only whitespace or comments changed')
  } else {
    if (isNew) { score += 3; reasons.push('new file') }
    const routes = added.filter(s => s.kind === 'route')
    const fns = added.filter(s => s.kind !== 'route')
    if (fns.length > 0) { score += Math.min(4, 2 + fns.length); reasons.push(`new ${fns.map(s => s.name).slice(0, 4).join(', ')}`) }
    if (routes.length > 0) { score += 3; reasons.push(`new endpoint ${routes.map(s => s.name).slice(0, 3).join(', ')}`) }
    if (modified.length > 0) { score += Math.min(3, modified.length); reasons.push(`changed ${modified.map(s => s.name).slice(0, 4).join(', ')}`) }
    if (removed.length > 0) { score += 1; reasons.push(`removed ${removed.slice(0, 3).join(', ')}`) }
    if (newImports.length > 0) { score += 2; reasons.push(`new dependency ${newImports.slice(0, 3).join(', ')}`) }
    if (topics.includes('authentication') || topics.includes('security')) { score += 2; reasons.push('touches auth/security') }
    if (topics.includes('database')) { score += 1; reasons.push('touches data access') }
    if (addedLines + removedLines >= 25) { score += 2; reasons.push(`${addedLines + removedLines} lines changed`) }
    else if (addedLines + removedLines >= 8) score += 1
    if (/\.(md|txt|rst)$/i.test(change.path)) score = Math.min(score, 1)
    if (/(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\./.test(change.path)) score = Math.max(0, score - 1)
  }
  return { path: change.path, isNew, added, removed, modified, addedLines, removedLines, topics, ranges, newImports, isTrivial, reasons, score: Math.min(10, score) }
}

/** Does a batch match a focus such as "database queries"? */
export function matchesFocus(focus: string, analyses: readonly ChangeAnalysis[], text: string): boolean {
  const wanted = topicsInFocus(focus)
  if (wanted.length > 0 && analyses.some(a => a.topics.some(t => wanted.includes(t)))) return true
  const terms = focusTerms(focus)
  const hay = (text + ' ' + analyses.map(a => a.path + ' ' + a.added.map(s => s.name).join(' ')).join(' ')).toLowerCase()
  return terms.some(t => hay.includes(t))
}
