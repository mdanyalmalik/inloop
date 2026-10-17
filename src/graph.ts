// The code index: every symbol of the project's source files, who calls whom,
// and flows traced from an entry point. Edges say how they are known:
// `confirmed` when the call is written in the code and resolves to exactly
// one definition the file can see, `inferred` when it rests on a name or URL
// match, `runtime` where only running the code would tell.

import type { InloopConfidence, InloopFlow, InloopFlowEdge, InloopFlowNode, InloopRef } from '../types'
import {
  type CallSite,
  type CodeSymbol,
  extractSymbols,
  findCalls,
  importBindings,
  isSourceFile,
} from './analysis'

export type IndexedFile = { path: string; text: string }

export type FileEntry = {
  path: string
  text: string
  lines: string[]
  symbols: CodeSymbol[]
  imports: Map<string, string>
}

export type CodeIndex = {
  rev?: string
  files: Map<string, FileEntry>
  symbols: CodeSymbol[]
  byName: Map<string, CodeSymbol[]>
}

export type Edge = {
  from: CodeSymbol
  to: CodeSymbol | ExternalTarget
  line: number
  label: string
  confidence: InloopConfidence
}

export type ExternalTarget = { external: true; name: string; kind: 'library' | 'database' | 'http' }

const DB_RECEIVER = /^(db|database|pool|client|conn|connection|knex|prisma|sql|collection|repo|repository|store|users?|model|session|cursor|tx|trx)$/i

export function symbolId(s: CodeSymbol): string {
  return `${s.path}:${s.line}:${s.name}`
}

export function buildIndex(files: readonly IndexedFile[], rev?: string): CodeIndex {
  const index: CodeIndex = { rev, files: new Map(), symbols: [], byName: new Map() }
  for (const f of files) {
    if (!isSourceFile(f.path)) continue
    const symbols = extractSymbols(f.text, f.path)
    index.files.set(f.path, { path: f.path, text: f.text, lines: f.text.split('\n'), symbols, imports: importBindings(f.text) })
    for (const s of symbols) {
      index.symbols.push(s)
      const list = index.byName.get(s.name) ?? []
      list.push(s)
      index.byName.set(s.name, list)
    }
  }
  return index
}

/** The innermost symbol whose lines hold `line` in `path`. */
export function enclosingSymbol(index: CodeIndex, path: string, line: number): CodeSymbol | undefined {
  const file = index.files.get(path)
  if (file === undefined) return undefined
  return file.symbols
    .filter(s => s.kind !== 'route' && s.line <= line && line <= s.endLine)
    .sort((a, b) => (a.endLine - a.line) - (b.endLine - b.line))[0]
}

function bodyOf(index: CodeIndex, s: CodeSymbol): string {
  const file = index.files.get(s.path)
  return file === undefined ? '' : file.lines.slice(s.line - 1, s.endLine).join('\n')
}

/** Does `fromPath` import something that resolves to `toPath`? */
function importsFile(fromPath: string, imports: Map<string, string>, name: string, toPath: string): boolean {
  const mod = imports.get(name)
  if (mod === undefined) return false
  if (!mod.startsWith('.')) return false
  const dir = fromPath.split('/').slice(0, -1)
  for (const part of mod.split('/')) {
    if (part === '.' || part === '') continue
    if (part === '..') dir.pop()
    else dir.push(part)
  }
  const target = dir.join('/').replace(/\.(m|c)?(j|t)sx?$|\.py$/, '')
  const bare = toPath.replace(/\.(m|c)?(j|t)sx?$|\.py$/, '')
  return target === bare || target === bare.replace(/\/index$/, '')
}

/** Matches a request URL against a route pattern such as /api/users/:id. */
export function urlMatches(routeUrl: string, url: string): boolean {
  const clean = (u: string) => u.split('?')[0]!.replace(/\/+$/, '') || '/'
  const r = clean(routeUrl).split('/')
  const u = clean(url).split('/')
  if (r.length !== u.length) return false
  return r.every((seg, i) => seg.startsWith(':') || /^[{<].*[}>]$/.test(seg) || seg === '*' || seg === u[i])
}

function resolveCall(index: CodeIndex, from: CodeSymbol, call: CallSite): Edge | null {
  const file = index.files.get(from.path)
  const imports = file?.imports ?? new Map<string, string>()
  if (call.kind === 'http') {
    const routes = index.symbols.filter(s => s.kind === 'route' && s.url !== undefined && urlMatches(s.url, call.url ?? '') &&
      (s.method === 'ANY' || s.method === 'ALL' || s.method === 'USE' || call.method === undefined || s.method === call.method))
    const route = routes[0]
    if (route !== undefined) {
      return { from, to: route, line: call.line, label: `HTTP ${call.method ?? ''} ${call.url} (matched by URL)`.replace('  ', ' '), confidence: 'inferred' }
    }
    return { from, to: { external: true, name: `${call.method ?? 'GET'} ${call.url}`, kind: 'http' }, line: call.line, label: 'HTTP request; no matching route in this repository', confidence: 'runtime' }
  }
  const isMember = call.receiver !== undefined && call.receiver !== 'this' && call.receiver !== 'self' && imports.get(call.receiver) === undefined
  // `host.run()` on some object is that object's method, never a plain function that happens to share the name.
  const candidates = (index.byName.get(call.name) ?? []).filter(s => s.kind !== 'route' && !(s.path === from.path && s.line === from.line) &&
    !(isMember && s.kind !== 'method'))
  if (candidates.length === 0) {
    if (call.receiver !== undefined && call.receiver !== 'this' && call.receiver !== 'self') {
      const mod = imports.get(call.receiver)
      if (DB_RECEIVER.test(call.receiver) || (mod !== undefined && /(pg|mysql|sqlite|mongo|prisma|knex|sequelize|typeorm|redis|db)/i.test(mod))) {
        return { from, to: { external: true, name: `${call.receiver}.${call.name}()`, kind: 'database' }, line: call.line, label: 'data access', confidence: 'confirmed' }
      }
      if (mod !== undefined && !mod.startsWith('.')) {
        return { from, to: { external: true, name: `${call.receiver}.${call.name}()`, kind: 'library' }, line: call.line, label: `library call (${mod})`, confidence: 'confirmed' }
      }
    }
    return null
  }
  const sameFile = candidates.filter(s => s.path === from.path)
  const imported = candidates.filter(s => importsFile(from.path, imports, call.name, s.path) ||
    (call.receiver !== undefined && importsFile(from.path, imports, call.receiver, s.path)))
  const pick = imported[0] ?? sameFile[0] ?? candidates[0]!
  const isUnique = imported.length === 1 || (imported.length === 0 && sameFile.length === 1) || candidates.length === 1
  const isVisible = imported.length > 0 || sameFile.length > 0
  let confidence: InloopConfidence = isUnique && isVisible ? 'confirmed' : 'inferred'
  let label = call.kind === 'callback' ? 'event handler / callback' : call.kind === 'render' ? 'renders' : 'calls'
  if (isMember && pick.kind === 'method') {
    confidence = 'inferred'
    label = `method call on ${call.receiver} (receiver type not checked)`
  }
  if (!isVisible) label += '; matched by name, no import seen'
  if (candidates.length > 1 && !isUnique) label += `; ${candidates.length} definitions share the name`
  return { from, to: pick, line: call.line, label, confidence }
}

/** What `s` calls, renders, requests or registers, resolved against the index. */
export function calleesOf(index: CodeIndex, s: CodeSymbol): Edge[] {
  const out: Edge[] = []
  const seen = new Set<string>()
  if (s.kind === 'route') {
    for (const name of s.handlers ?? []) {
      const candidates = index.byName.get(name) ?? []
      const file = index.files.get(s.path)
      const pick = candidates.find(c => c.path === s.path) ??
        candidates.find(c => importsFile(s.path, file?.imports ?? new Map(), name, c.path)) ?? candidates[0]
      if (pick === undefined || seen.has(symbolId(pick))) continue
      seen.add(symbolId(pick))
      const isConfirmed = pick.path === s.path || importsFile(s.path, file?.imports ?? new Map(), name, pick.path) || candidates.length === 1
      out.push({ from: s, to: pick, line: s.line, label: 'route handler', confidence: isConfirmed ? 'confirmed' : 'inferred' })
    }
    if (s.endLine > s.line) {
      for (const call of findCalls(bodyOf(index, s), s.line)) {
        const edge = resolveCall(index, s, call)
        const key = edge === null ? '' : 'external' in edge.to ? edge.to.name : symbolId(edge.to)
        if (edge !== null && !seen.has(key)) { seen.add(key); out.push(edge) }
      }
    }
    return out
  }
  // Calls made inside a function nested in this one belong to that function.
  const nested = (index.files.get(s.path)?.symbols ?? []).filter(n => n !== s && n.kind !== 'route' && n.line > s.line && n.endLine <= s.endLine)
  const isInNested = (line: number) => nested.some(n => line >= n.line && line <= n.endLine)
  const calls = findCalls(bodyOf(index, s), s.line)
    .filter(c => !(c.line === s.line && c.name === s.name))
    .filter(c => !isInNested(c.line))
  for (const call of calls) {
    const edge = resolveCall(index, s, call)
    if (edge === null) continue
    const key = 'external' in edge.to ? edge.to.name : symbolId(edge.to)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(edge)
  }
  return out
}

/** Who calls `s`: every symbol whose callees resolve to it. */
export function callersOf(index: CodeIndex, s: CodeSymbol): Edge[] {
  const out: Edge[] = []
  const needle = s.kind === 'route' ? null : new RegExp(`\\b${s.name.replace(/[$]/g, '\\$')}\\b`)
  for (const other of index.symbols) {
    if (other === s) continue
    if (needle !== null && !needle.test(bodyOf(index, other)) && !(other.handlers ?? []).includes(s.name)) continue
    for (const edge of calleesOf(index, other)) {
      if (!('external' in edge.to) && symbolId(edge.to) === symbolId(s)) out.push(edge)
    }
  }
  return out
}

function words(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 1)
}

const STOP = new Set(['the', 'what', 'when', 'how', 'does', 'happens', 'show', 'me', 'explain', 'only', 'is', 'are', 'a', 'an', 'of', 'to', 'in', 'on', 'i', 'my', 'and', 'it', 'this', 'that', 'user', 'click', 'clicks', 'button', 'where', 'from', 'get', 'gets', 'with', 'for', 'run', 'runs', 'ran', 'called', 'used', 'do', 'done', 'happen'])

const STEMS: Record<string, string[]> = {
  login: ['login', 'log', 'signin', 'sign', 'authenticate', 'auth'],
  logs: ['login', 'log'],
  token: ['token', 'jwt', 'sign'],
  tokens: ['token', 'jwt'],
  generated: ['create', 'sign', 'issue', 'generate'],
  created: ['create', 'sign', 'issue'],
  database: ['db', 'query', 'save', 'insert', 'find'],
  password: ['password', 'hash', 'verify', 'compare'],
  register: ['register', 'signup', 'create'],
}

/** Symbols that best match a natural-language description, best first. */
export function findSymbols(index: CodeIndex, query: string, limit = 12): CodeSymbol[] {
  const q = words(query).filter(w => !STOP.has(w))
  const expanded = new Set(q)
  for (const w of q) for (const s of STEMS[w] ?? []) expanded.add(s)
  if (expanded.size === 0) return []
  const scored = index.symbols.map(s => {
    const nameWords = words(s.name)
    let score = 0
    for (const w of expanded) {
      if (nameWords.includes(w)) score += 4
      else if (nameWords.some(n => n.startsWith(w) || w.startsWith(n) && n.length > 2)) score += 2
      if (words(s.path).includes(w)) score += 1
    }
    if (score > 0 && (s.kind === 'route' || s.kind === 'component')) score += 1
    if (score > 0 && s.isExported) score += 0.5
    return { s, score }
  })
  return scored
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.s.path.localeCompare(b.s.path))
    .slice(0, limit)
    .map(x => x.s)
}

export function lookup(index: CodeIndex, name: string, path?: string): CodeSymbol | undefined {
  const all = index.byName.get(name) ?? index.symbols.filter(s => s.name.toLowerCase() === name.toLowerCase())
  return all.find(s => path === undefined || s.path === path) ?? all[0]
}

/**
 * The flow from `entries`, breadth first, every node a definition in the
 * index or an external endpoint a call names, every edge one `calleesOf` found.
 */
/** Method names too common to follow when the receiver's type is unknown: `seen.has()` is not the repo's has(). */
const GENERIC_METHODS = new Set([
  'has', 'add', 'get', 'set', 'delete', 'clear', 'push', 'pop', 'shift', 'unshift', 'map', 'filter', 'find', 'some', 'every', 'includes',
  'keys', 'values', 'entries', 'forEach', 'reduce', 'join', 'split', 'slice', 'splice', 'concat', 'sort', 'then', 'catch', 'finally', 'call',
  'apply', 'bind', 'toString', 'update', 'read', 'write', 'close', 'open', 'start', 'stop', 'run', 'send', 'next', 'emit', 'on', 'off',
  'once', 'test', 'match', 'replace', 'trim', 'parse', 'stringify', 'resolve', 'reject', 'append', 'remove', 'size', 'length', 'cancel',
])

/** A call worth drawing: not a common method name matched to some definition by name alone. */
function isWorthFollowing(edge: Edge): boolean {
  if ('external' in edge.to || edge.confidence === 'confirmed' || edge.label.startsWith('HTTP')) return true
  return !GENERIC_METHODS.has(edge.to.name)
}

/**
 * A flow along the steps an explanation named, in the order they run. Each
 * link is checked against the code: a direct call keeps its confidence, a call
 * through one or two functions in between says which, and steps no call ties
 * together are linked "by reading the code" (inferred). Each step shows up to
 * three confirmed calls of its own beside it. Names with no definition are left
 * out and noted.
 */
export function pathFlow(
  index: CodeIndex,
  steps: readonly { name: string; does?: string }[],
  options: { title: string; id: string; at: number; sideCalls?: number; maxNodes?: number },
): InloopFlow | null {
  const sideCalls = options.sideCalls ?? 3
  const maxNodes = options.maxNodes ?? 24
  const notes: string[] = []
  const main: { s: CodeSymbol; does?: string }[] = []
  for (const st of steps) {
    const name = st.name.trim().replace(/\(\)$/, '')
    if (name === '') continue
    const s = lookup(index, name)
    if (s === undefined) {
      notes.push(`"${name}" was mentioned but no definition with that name exists in the code; it is left out.`)
      continue
    }
    if (main.some(m => symbolId(m.s) === symbolId(s))) continue
    main.push({ s, does: st.does })
  }
  if (main.length < 2) return null
  const nodes: InloopFlowNode[] = []
  const edges: InloopFlowEdge[] = []
  const ids = new Map<string, string>()
  const node = (s: CodeSymbol | ExternalTarget, depth: number, ref: InloopRef | undefined, note?: string): string => {
    const key = 'external' in s ? `ext:${s.kind}:${s.name}` : symbolId(s)
    const held = ids.get(key)
    if (held !== undefined) return held
    const id = `n${nodes.length}`
    ids.set(key, id)
    nodes.push({ id, label: 'external' in s ? s.name : nameIn(index, s), kind: s.kind, ref, depth, ...(note !== undefined && note !== '' ? { note } : {}) })
    return id
  }
  const refOf = (s: CodeSymbol): InloopRef => ({ path: s.path, line: s.line, endLine: s.endLine, rev: index.rev, symbol: s.name })
  const path = main.map((m, i) => node(m.s, i, refOf(m.s), m.does))
  for (let i = 0; i + 1 < main.length; i++) {
    edges.push({ from: path[i]!, to: path[i + 1]!, ...link(index, main[i]!.s, main[i + 1]!.s) })
  }
  if (edges.some(e => e.label.startsWith('linked by reading'))) {
    notes.push('Links "by reading the code" join steps the explanation describes that no call in the code ties together directly (for example across an HTTP request or an event).')
  }
  // Each step's own confirmed calls, three at most, so the main line stays easy to read.
  const onPath = new Set(main.map(m => symbolId(m.s)))
  main.forEach((m, i) => {
    let added = 0
    for (const edge of calleesOf(index, m.s)) {
      if (added >= sideCalls || nodes.length >= maxNodes) break
      if (edge.confidence !== 'confirmed') continue
      if ('external' in edge.to ? edge.to.kind === 'library' : onPath.has(symbolId(edge.to))) continue
      // A utility called from all over (a UI helper, a formatter) says little about this flow.
      if (!('external' in edge.to) && index.symbols.length < 4000 && callersOf(index, edge.to).length >= 5) continue
      const to = node(edge.to, i + 1, 'external' in edge.to ? { path: m.s.path, line: edge.line, rev: index.rev } : refOf(edge.to))
      if (edges.some(e => e.to === to)) continue
      edges.push({ from: path[i]!, to, label: edge.label, confidence: edge.confidence })
      added++
    }
  })
  if (edges.some(e => e.confidence === 'runtime')) notes.push('Links marked "runtime" depend on what the program does when it runs and cannot be confirmed by reading the code.')
  return { id: options.id, title: options.title, rev: index.rev, nodes, edges, notes, at: options.at, path }
}

/** A function's name, with its file when another definition shares the name. */
function nameIn(index: CodeIndex, s: CodeSymbol): string {
  const name = s.kind === 'route' ? s.name : `${s.name}()`
  return (index.byName.get(s.name)?.length ?? 0) > 1 ? `${name} in ${s.path.split('/').pop()}` : name
}

/** How one step reaches the next: a direct call, a call through one or two functions in between, or only by reading. */
function link(index: CodeIndex, from: CodeSymbol, to: CodeSymbol): { label: string; confidence: InloopConfidence } {
  const direct = calleesOf(index, from).find(e => !('external' in e.to) && symbolId(e.to) === symbolId(to))
  if (direct !== undefined) return { label: direct.label, confidence: direct.confidence }
  // Breadth first, two calls deep at most.
  let frontier: { s: CodeSymbol; via: CodeSymbol[]; isSure: boolean }[] = [{ s: from, via: [], isSure: true }]
  const seen = new Set([symbolId(from)])
  for (let depth = 0; depth < 3; depth++) {
    const next: typeof frontier = []
    for (const f of frontier) {
      for (const e of calleesOf(index, f.s)) {
        if ('external' in e.to || !isWorthFollowing(e) || seen.has(symbolId(e.to))) continue
        const isSure = f.isSure && e.confidence === 'confirmed'
        if (symbolId(e.to) === symbolId(to) && f.via.length > 0) {
          return { label: `calls it through ${f.via.map(v => nameIn(index, v)).join(' → ')}`, confidence: isSure ? 'confirmed' : 'inferred' }
        }
        seen.add(symbolId(e.to))
        next.push({ s: e.to, via: [...f.via, e.to], isSure })
      }
    }
    frontier = next.slice(0, 200)
  }
  return { label: 'linked by reading the code; no call found between them', confidence: 'inferred' }
}

export function traceFlow(
  index: CodeIndex,
  entries: readonly CodeSymbol[],
  options: { title: string; maxDepth?: number; maxNodes?: number; exclude?: (s: CodeSymbol) => boolean; id: string; at: number },
): InloopFlow {
  const maxDepth = options.maxDepth ?? 6
  const maxNodes = options.maxNodes ?? 24
  const nodes: InloopFlowNode[] = []
  const edges: InloopFlowEdge[] = []
  const notes: string[] = []
  const ids = new Map<string, string>()
  const queue: { s: CodeSymbol; depth: number }[] = []
  const add = (s: CodeSymbol, depth: number): string => {
    const key = symbolId(s)
    const held = ids.get(key)
    if (held !== undefined) return held
    const id = `n${nodes.length}`
    ids.set(key, id)
    nodes.push({
      id,
      label: s.kind === 'route' ? s.name : `${s.name}()`,
      kind: s.kind,
      ref: { path: s.path, line: s.line, endLine: s.endLine, rev: index.rev, symbol: s.name },
      depth,
    })
    queue.push({ s, depth })
    return id
  }
  for (const e of entries) add(e, 0)
  let truncated = false
  while (queue.length > 0) {
    const { s, depth } = queue.shift()!
    if (depth >= maxDepth) continue
    const fromId = ids.get(symbolId(s))!
    for (const edge of calleesOf(index, s)) {
      if (!isWorthFollowing(edge)) continue
      if (!('external' in edge.to) && options.exclude?.(edge.to) === true) continue
      if (nodes.length >= maxNodes) { truncated = true; break }
      let toId: string
      if ('external' in edge.to) {
        const key = `ext:${edge.to.kind}:${edge.to.name}`
        toId = ids.get(key) ?? `n${nodes.length}`
        if (!ids.has(key)) {
          ids.set(key, toId)
          nodes.push({ id: toId, label: edge.to.name, kind: edge.to.kind, ref: { path: s.path, line: edge.line, rev: index.rev }, depth: depth + 1 })
        }
      } else {
        toId = add(edge.to, depth + 1)
      }
      if (!edges.some(x => x.from === fromId && x.to === toId)) {
        edges.push({ from: fromId, to: toId, label: edge.label, confidence: edge.confidence })
      }
    }
  }
  if (truncated) notes.push(`Stopped at ${maxNodes} steps; ask about one step to follow it further.`)
  if (edges.some(e => e.confidence === 'runtime')) notes.push('Steps marked "runtime" depend on what the program does when it runs and cannot be confirmed by reading the code.')
  if (edges.some(e => e.confidence === 'inferred')) notes.push('Steps marked "inferred" rest on a name or URL match, not a resolved import.')
  return { id: options.id, title: options.title, rev: index.rev, nodes, edges, notes, at: options.at }
}

/**
 * The flow as a tree for reading top to bottom: each node under the first
 * step that reaches it, depth first, so a call chain reads in order.
 */
export function flowOrder(flow: InloopFlow): { node: InloopFlowNode; depth: number; via?: InloopFlowEdge }[] {
  const out: { node: InloopFlowNode; depth: number; via?: InloopFlowEdge }[] = []
  const byId = new Map(flow.nodes.map(n => [n.id, n]))
  const seen = new Set<string>()
  const visit = (id: string, depth: number, via?: InloopFlowEdge) => {
    const node = byId.get(id)
    if (node === undefined || seen.has(id)) return
    seen.add(id)
    out.push({ node, depth, via })
    for (const e of flow.edges) if (e.from === id) visit(e.to, depth + 1, e)
  }
  const targets = new Set(flow.edges.map(e => e.to))
  for (const n of flow.nodes) if (!targets.has(n.id)) visit(n.id, 0)
  for (const n of flow.nodes) visit(n.id, 0)
  return out
}
