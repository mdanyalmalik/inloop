import { describe, expect, test } from 'claude-code/testing'

import { analyzeChange, extractSymbols, findCalls, matchesFocus, topicsOf } from '../src/analysis'
import { Batcher, hash } from '../src/batcher'
import { changedLines, formatRanges, summarizeDiff, unifiedDiff } from '../src/diff'
import { describeFlow, extractJson, kindOf, parseReply, partsFor, speakable, staticCard, diffBatch } from '../src/explain'
import { buildIndex, callersOf, findSymbols, lookup, traceFlow, urlMatches } from '../src/graph'
import { isSafeRev, isSensitive, redact, toRelative } from '../src/security'
import { DEMO_FIRST, DEMO_HEAD } from './fixtures'
import { SAY_LISTING } from './harness'
import { needsBetterVoice, parseVoices, pickVoice, rankVoices } from '../src/voices'

const files = (set: Record<string, string>) => Object.entries(set).map(([path, text]) => ({ path, text }))

describe('security', () => {
  test('paths stay inside the project', () => {
    expect(toRelative('/p/app', '/p/app/src/a.js')).toBe('src/a.js')
    expect(toRelative('/p/app', 'src/../src/a.js')).toBe('src/a.js')
    expect(toRelative('/p/app', '../other/a.js')).toBe(null)
    expect(toRelative('/p/app', '/p/app2/a.js')).toBe(null)
    expect(toRelative('/p/app', '/etc/passwd')).toBe(null)
    expect(toRelative('/p/app', 'a\0b')).toBe(null)
  })

  test('sensitive files are recognised', () => {
    for (const p of ['.env', 'config/.env.local', 'id_rsa', 'certs/server.pem', '.aws/credentials', 'secrets.json', '.git/config']) {
      expect(isSensitive(p)).toBe(true)
    }
    for (const p of ['src/env.js', 'server/auth/tokens.js', 'README.md']) expect(isSensitive(p)).toBe(false)
  })

  test('revisions that could be options or ranges are refused', () => {
    expect(isSafeRev('abc123')).toBe(true)
    expect(isSafeRev('HEAD~3')).toBe(true)
    expect(isSafeRev('--output=/tmp/x')).toBe(false)
    expect(isSafeRev('a..b')).toBe(false)
    expect(isSafeRev('a b')).toBe(false)
  })

  test('secrets are masked, env references kept', () => {
    const text = `const apiKey = "sk-ant-abcdefghijklmnopqrstuvwx"\nconst password = 'hunter2hunter2'\nconst secret = process.env.JWT_SECRET`
    const out = redact(text)
    expect(out.includes('abcdefghijklmnop')).toBe(false)
    expect(out.includes('hunter2hunter2')).toBe(false)
    expect(out.includes('process.env.JWT_SECRET')).toBe(true)
  })
})

describe('analysis', () => {
  test('finds functions, routes and handlers in the demo server', () => {
    const syms = extractSymbols(DEMO_HEAD['server/app.js']!, 'server/app.js')
    const names = syms.map(s => s.name)
    expect(names.includes('POST /api/login')).toBe(true)
    expect(names.includes('GET /api/me')).toBe(true)
    expect(names.includes('me')).toBe(true)
    const me = syms.find(s => s.name === 'GET /api/me')!
    expect(me.handlers).toEqual(['requireAuth', 'me'])
  })

  test('symbol ranges cover the function body', () => {
    const text = DEMO_HEAD['server/auth/controller.js']!
    const login = extractSymbols(text, 'server/auth/controller.js').find(s => s.name === 'login')!
    const body = text.split('\n').slice(login.line - 1, login.endLine).join('\n')
    expect(body.startsWith('async function login')).toBe(true)
    expect(body.trim().endsWith('}')).toBe(true)
    expect(body.includes('createToken(user)')).toBe(true)
    expect(login.isAsync).toBe(true)
  })

  test('React component and its event handler', () => {
    const syms = extractSymbols(DEMO_HEAD['web/LoginForm.jsx']!, 'web/LoginForm.jsx')
    expect(syms.find(s => s.name === 'LoginForm')?.kind).toBe('component')
    expect(syms.some(s => s.name === 'handleLogin')).toBe(true)
    const calls = findCalls(DEMO_HEAD['web/LoginForm.jsx']!, 1)
    expect(calls.some(c => c.kind === 'callback' && c.name === 'handleLogin')).toBe(true)
  })

  test('HTTP calls to literal URLs are found with their method', () => {
    const calls = findCalls(DEMO_HEAD['web/api.js']!, 1)
    const http = calls.filter(c => c.kind === 'http')
    expect(http.some(c => c.url === '/api/login' && c.method === 'POST')).toBe(true)
  })

  test('a new function scores as significant; a comment-only edit does not', () => {
    const before = DEMO_FIRST['server/auth/controller.js']!
    const after = before + '\nfunction logout(req, res) {\n  res.clearCookie("sid")\n  res.status(204).end()\n}\n'
    const a = analyzeChange({ path: 'server/auth/controller.js', before, after, snippets: [], tools: ['Edit'], at: 0 })
    expect(a.added.map(s => s.name)).toEqual(['logout'])
    expect(a.score >= 3).toBe(true)
    const c = analyzeChange({ path: 'server/auth/controller.js', before, after: before + '\n// just a note\n', snippets: [], tools: ['Edit'], at: 0 })
    expect(c.isTrivial).toBe(true)
    expect(c.score).toBe(0)
  })

  test('a new dependency in package.json is noticed', () => {
    const before = DEMO_FIRST['package.json']!
    const after = DEMO_HEAD['package.json']!
    const a = analyzeChange({ path: 'package.json', before, after, snippets: [], tools: ['Edit'], at: 0 })
    expect(a.newImports.includes('jsonwebtoken')).toBe(true)
  })

  test('focus matching by topic words', () => {
    const tokens = analyzeChange({ path: 'server/auth/tokens.js', before: null, after: DEMO_HEAD['server/auth/tokens.js']!, snippets: [], tools: ['Write'], at: 0 })
    const form = analyzeChange({ path: 'web/session.js', before: null, after: DEMO_HEAD['web/session.js']!, snippets: [], tools: ['Write'], at: 0 })
    expect(matchesFocus('only tell me about database queries', [tokens], '')).toBe(false)
    expect(matchesFocus('authentication tokens', [tokens], '')).toBe(true)
    expect(matchesFocus('database queries', [form], '')).toBe(false)
  })
})

describe('diff and batching', () => {
  test('unified diff marks the changed lines', () => {
    const before = 'a\nb\nc\nd\ne\nf\ng'
    const after = 'a\nb\nC\nd\ne\nf\ng\nh'
    const d = unifiedDiff(before, after)
    expect(d.includes('-c')).toBe(true)
    expect(d.includes('+C')).toBe(true)
    expect(changedLines(d)).toEqual([3, 8])
  })

  test('a replaced line reads as git shows it: removed, then added', () => {
    const d = unifiedDiff('a\nb\nold\nc\n', 'a\nb\nnew\nc\n')
    expect(d.split('\n').filter(l => /^[-+]/.test(l))).toEqual(['-old', '+new'])
  })

  test('a new file has no extra empty line at its end', () => {
    expect(unifiedDiff('', 'a\nb\n')).toBe('@@ -0,0 +1,2 @@\n+a\n+b')
    expect(unifiedDiff('a\nb\n', '')).toBe('@@ -1,2 +0,0 @@\n-a\n-b')
  })

  test('an edit known only by its snippets, merged with one known whole, is never taken for a new file', () => {
    const b = new Batcher({ quietMs: 1000, maxWaitMs: 10_000, maxFiles: 10 })
    b.add({ path: 'a.js', before: null, after: null, snippets: [{ old: 'x\n', new: '' }], tools: ['Edit'], at: 0 })
    b.add({ path: 'a.js', before: 'y\nz\n', after: 'y\nZ\n', snippets: [], tools: ['Edit'], at: 100 })
    const [held] = b.take()
    expect(held!.before === null && held!.after !== null).toBe(false)
    expect(held!.snippets.length).toBe(2)
  })

  test('edits close together form one batch per file, flushed after quiet', () => {
    const b = new Batcher({ quietMs: 1000, maxWaitMs: 10_000, maxFiles: 10 })
    b.add({ path: 'a.js', before: 'x', after: 'y', snippets: [], tools: ['Edit'], at: 0 })
    b.add({ path: 'b.js', before: null, after: 'z', snippets: [], tools: ['Write'], at: 300 })
    b.add({ path: 'a.js', before: 'y', after: 'w', snippets: [], tools: ['Edit'], at: 600 })
    expect(b.isDue(1200)).toBe(false)
    expect(b.isDue(1600)).toBe(true)
    const batch = b.take()
    expect(batch.length).toBe(2)
    expect(batch.find(c => c.path === 'a.js')).toEqual({ path: 'a.js', before: 'x', after: 'w', snippets: [], tools: ['Edit'], at: 600 })
    expect(b.size).toBe(0)
  })

  test('a long burst still flushes at the maximum wait', () => {
    const b = new Batcher({ quietMs: 1000, maxWaitMs: 3000, maxFiles: 10 })
    for (let t = 0; t <= 3500; t += 500) b.add({ path: 'a.js', before: '', after: String(t), snippets: [], tools: ['Edit'], at: t })
    expect(b.dueAt()).toBe(3000)
  })

  test('hash is stable', () => {
    expect(hash('abc')).toBe(hash('abc'))
    expect(hash('abc') === hash('abd')).toBe(false)
  })
})

describe('code index and flows', () => {
  const index = buildIndex(files(DEMO_HEAD))

  test('login flow from the button to the database, every node real', () => {
    const entry = lookup(index, 'LoginForm')!
    const flow = traceFlow(index, [entry], { title: 'login', id: 'f', at: 0 })
    const labels = flow.nodes.map(n => n.label)
    for (const l of ['LoginForm()', 'handleLogin()', 'loginRequest()', 'POST /api/login', 'login()', 'findUserByEmail()', 'verifyPassword()', 'createToken()', 'saveToken()']) {
      expect(labels.includes(l)).toBe(true)
    }
    // Every in-repo node points at a definition that exists where it says.
    for (const n of flow.nodes) {
      if (n.kind === 'database' || n.kind === 'library' || n.kind === 'http') continue
      const text = DEMO_HEAD[n.ref!.path]!
      const line = text.split('\n')[n.ref!.line! - 1]!
      const name = n.label.replace(/\(\)$/, '')
      expect(line.includes(name.startsWith('POST ') ? '/api/login' : name)).toBe(true)
    }
    const byLabel = new Map(flow.nodes.map(n => [n.label, n.id]))
    const edge = (a: string, b: string) => flow.edges.find(e => e.from === byLabel.get(a) && e.to === byLabel.get(b))
    expect(edge('LoginForm()', 'handleLogin()')?.confidence).toBe('confirmed')
    expect(edge('loginRequest()', 'POST /api/login')?.confidence).toBe('inferred')
    expect(edge('POST /api/login', 'login()')?.confidence).toBe('confirmed')
    expect(edge('login()', 'createToken()')?.confidence).toBe('confirmed')
    expect(edge('findUserByEmail()', 'query()')?.confidence).toBe('confirmed')
    // handleLogin's calls are its own, not the component's.
    expect(edge('LoginForm()', 'loginRequest()')).toBe(undefined)
    expect(edge('handleLogin()', 'loginRequest()')?.confidence).toBe('confirmed')
    expect(labels.some(l => l.startsWith('jwt.sign'))).toBe(true)
    expect(describeFlow(flow).includes('[inferred]')).toBe(true)
  })

  test('callers of createToken', () => {
    const s = lookup(index, 'createToken')!
    expect(callersOf(index, s).map(e => e.from.name)).toEqual(['login'])
  })

  test('natural-language search finds token creation', () => {
    const found = findSymbols(index, 'how authentication tokens are generated').map(s => s.name)
    expect(found.slice(0, 3).includes('createToken')).toBe(true)
  })

  test('URL patterns with parameters', () => {
    expect(urlMatches('/api/users/:id', '/api/users/42')).toBe(true)
    expect(urlMatches('/api/users/:id', '/api/users')).toBe(false)
    expect(urlMatches('/api/login', '/api/login?x=1')).toBe(true)
  })

  test('the first commit has sessions, not tokens', () => {
    const old = buildIndex(files(DEMO_FIRST), 'first')
    expect(lookup(old, 'createToken')).toBe(undefined)
    expect(lookup(old, 'createSession')?.path).toBe('server/auth/sessions.js')
    const flow = traceFlow(old, [lookup(old, 'POST /api/login')!], { title: 'old login', id: 'g', at: 0 })
    expect(flow.rev).toBe('first')
    expect(flow.nodes.some(n => n.label === 'createSession()')).toBe(true)
  })
})

describe('explanations', () => {
  test('JSON is found inside prose and fences', () => {
    expect(extractJson('Sure!\n```json\n{"a": 1, "b": "x}"}\n```')).toEqual({ a: 1, b: 'x}' })
    expect(extractJson('{"answer": "hi"} trailing')).toEqual({ answer: 'hi' })
    expect(extractJson('no json here')).toBe(null)
  })

  test('static card names the new function and its caller', () => {
    const before = DEMO_FIRST['server/auth/controller.js']!
    const after = DEMO_HEAD['server/auth/controller.js']!
    const changes = [
      { path: 'server/auth/tokens.js', before: null, after: DEMO_HEAD['server/auth/tokens.js']!, snippets: [], tools: ['Write'], at: 0 },
      { path: 'server/auth/controller.js', before, after, snippets: [], tools: ['Edit'], at: 0 },
    ]
    const analyses = changes.map(analyzeChange)
    const card = staticCard({ changes, analyses, diffs: diffBatch(changes) }, new Map([['createToken', ['login (server/auth/controller.js:11)']]]), 'c1', 0)
    expect(card.title.includes('createToken')).toBe(true)
    expect(card.summary.includes('called from login')).toBe(true)
    expect(card.files).toEqual(['server/auth/tokens.js', 'server/auth/controller.js'])
    expect(card.refs.some(r => r.path === 'server/auth/tokens.js' && r.line === 6)).toBe(true)
    expect(card.diff!.includes('+++ b/server/auth/tokens.js')).toBe(true)
  })

  test('speech text drops markdown and code', () => {
    expect(speakable('**Hi** `x` there\n```js\ncode()\n```\n[link](http://a)')).toBe('Hi x there link')
  })
})

describe('voices', () => {
  const voices = parseVoices(SAY_LISTING)

  test('parses names with parentheses and skips novelty voices', () => {
    expect(voices.find(v => v.name === 'Daniel (English (UK))')?.locale).toBe('en_GB')
    expect(voices.find(v => v.name === 'Zoe (Premium)')?.quality).toBe('premium')
    const offered = rankVoices(voices).map(v => v.name)
    expect(offered[0]).toBe('Zoe (Premium)')
    expect(offered.includes('Bubbles')).toBe(false)
    expect(offered.includes('Eddy (English (US))')).toBe(false)
    expect(offered.includes('Thomas')).toBe(false)
  })

  test('automatic picks the best installed; a chosen voice wins while installed', () => {
    expect(pickVoice(voices, '')).toBe('Zoe (Premium)')
    expect(pickVoice(voices, 'Daniel (English (UK))')).toBe('Daniel (English (UK))')
    expect(pickVoice(voices, 'Ava (Premium)')).toBe('Zoe (Premium)')
    const compactOnly = voices.filter(v => v.quality !== 'premium')
    expect(pickVoice(compactOnly, '')).toBe('Samantha')
    expect(needsBetterVoice(compactOnly)).toBe(true)
    expect(needsBetterVoice(voices)).toBe(false)
    expect(pickVoice([], '')).toBe(undefined)
  })

  test('spoken text leaves out paths, line numbers and markdown', () => {
    const summary = 'The agent added `isTokenExpiringSoon(claims, seconds)` at `server/auth/tokens.js` line 18 and exported it (line 24). It calls `verifyToken()` from tokens.js:10.\n\n## Effect\n- Nothing calls it yet.'
    const spoken = speakable(summary)
    expect(spoken).toBe('The agent added isTokenExpiringSoon(claims, seconds) at the tokens file and exported it. It calls verifyToken from the tokens file. Effect. Nothing calls it yet.')
    const long = 'One sentence here. '.repeat(60)
    expect(speakable(long).length <= 450).toBe(true)
    expect(speakable(long).endsWith('.')).toBe(true)
  })
})

describe('explanations sized to the change', () => {
  test('a one-liner gets no parts, a small change one or two, a spread-out change up to six', () => {
    const one = analyzeChange({ path: 'server/app.js', before: DEMO_HEAD['server/app.js']!, after: DEMO_HEAD['server/app.js']!.replace('3000', '3001'), snippets: [], tools: ['Edit'], at: 0 })
    expect(partsFor({ analyses: [one] })).toEqual({ min: 0, max: 1, summary: '1-2 sentences (at most 40 words)' })
    const fn = (name: string) => `\nfunction ${name}(a) {\n  const b = a + 1\n  return b * 2\n}\n`
    const small = analyzeChange({ path: 'server/app.js', before: DEMO_HEAD['server/app.js']!, after: DEMO_HEAD['server/app.js']! + fn('health'), snippets: [], tools: ['Edit'], at: 0 })
    expect(partsFor({ analyses: [small] }).max).toBe(2)
    const many = ['a.js', 'b.js', 'c.js', 'd.js'].map(path => analyzeChange({ path, before: '', after: fn('one') + fn('two') + fn('three'), snippets: [], tools: ['Write'], at: 0 }))
    expect(partsFor({ analyses: many }).max).toBe(6)
  })
})

describe('reading a whole commit', () => {
  test('code and docs are read; data, fixtures and vendored files are named; binaries and lockfiles skipped', () => {
    const k = (path: string, added = 10, removed = 0, isBinary = false) => kindOf({ path, added, removed, isBinary })
    expect(k('src/runtime/onnx/moe-split.ts', 535)).toBe('code')
    expect(k('tools/export/export_flux3.py', 589)).toBe('code')
    expect(k('README.md')).toBe('docs')
    expect(k('package-lock.json', 4000)).toBe('skip')
    expect(k('src/runtime/onnx/__fixtures__/tiny-moe.onnx', 0, 0, true)).toBe('skip')
    expect(k('src/runtime/image/__fixtures__/flux3-prompts.json', 1)).toBe('data')
    expect(k('public/third-party/onnxruntime-web/ort.mjs', 200)).toBe('data')
    expect(k('src/tokenizer/qwen-tokenizer.json', 669)).toBe('data')
    expect(k('tsconfig.json', 6)).toBe('code')
    expect(k('src/generated/schema.ts', 9000)).toBe('data')
  })
})

describe('diff summaries', () => {
  test('per file: lines added and removed, and the changed ranges', () => {
    const combined = [
      '--- a/server/app.js',
      '+++ b/server/app.js',
      '@@ -8,3 +8,5 @@',
      " app.post('/api/login', login)",
      "+app.post('/api/logout', logout)",
      "+app.post('/api/refresh', refresh)",
      " app.post('/api/register', register)",
      '-// old note',
      ' ',
      '--- a/web/session.js',
      '+++ b/web/session.js',
      '@@ -1,3 +1,2 @@',
      '--- an SQL-style comment line removed',
      ' export function saveToken(token) {',
      ' }',
    ].join('\n')
    const files = summarizeDiff(combined)
    expect(files.map(f => f.path)).toEqual(['server/app.js', 'web/session.js'])
    expect([files[0]!.added, files[0]!.removed]).toEqual([2, 1])
    // The removal sits after an unchanged line, so it is a range of its own.
    expect(files[0]!.ranges).toEqual([[9, 10], [12, 12]])
    expect(formatRanges(files[0]!.ranges)).toBe('9-10, 12')
    expect([files[1]!.added, files[1]!.removed]).toEqual([0, 1])
    expect(files[1]!.ranges).toEqual([[1, 1]])
    expect(files[1]!.hunks.startsWith('@@ -1,3 +1,2 @@')).toBe(true)
  })

  test("git's own patch preamble is left out of a file's hunks", () => {
    const patch = ['diff --git a/a.js b/a.js', 'index 1111111..2222222 100644', '--- a/a.js', '+++ b/a.js', '@@ -1 +1 @@', '-x', '+y',
      'diff --git a/new.js b/new.js', 'new file mode 100644', '--- /dev/null', '+++ b/new.js', '@@ -0,0 +1 @@', '+hello'].join('\n')
    const files = summarizeDiff(patch)
    expect(files.map(f => [f.path, f.added, f.removed])).toEqual([['a.js', 1, 1], ['new.js', 1, 0]])
    expect(files[0]!.hunks.includes('diff --git')).toBe(false)
  })
})

describe('explanation quality', () => {
  test('calls, routes and words inside strings or comments are not definitions', () => {
    const text = [
      "test('x', () => {",
      "  expect(diff.includes('+function refreshToken(token) {')).toBe(true)",
      "  const edit = { old_string: \"app.post('/api/register', register)\" }",
      "  // app.get('/api/old', handler)",
      '  const STEPPED = () => JSON.stringify({',
      '    a: 1,',
      '  })',
      '})',
    ].join('\n')
    expect(extractSymbols(text, 'tests/engine.test.tsx').map(s => `${s.kind} ${s.name}`)).toEqual(['function STEPPED'])
  })

  test('a return type with braces does not end the method on its first line', () => {
    const text = 'class Repo {\n  async dirtyEntries(): Promise<{ path: string }[]> {\n    const out = []\n    return out\n  }\n\n  head(): string { return "x" }\n}\n'
    const syms = extractSymbols(text, 'src/repo.ts')
    expect(syms.map(s => [s.name, s.line, s.endLine])).toEqual([['Repo', 1, 8], ['dirtyEntries', 2, 5], ['head', 7, 7]])
  })

  test('one method changed in a big class: the method is what changed, and only its lines set the topics', () => {
    const before = ['export class Store {', '  login(user) {', '    return createToken(user.password)', '  }', '', '  count() {', '    return 1', '  }', '}', ''].join('\n')
    const after = before.replace('return 1', 'return 2')
    const a = analyzeChange({ path: 'src/store.js', before, after, snippets: [], tools: ['Edit'], at: 0 })
    expect(a.modified.map(s => s.name)).toEqual(['count'])
    expect(a.topics.includes('authentication')).toBe(false)
    expect(a.reasons.some(r => r.includes('auth'))).toBe(false)
    expect(a.ranges).toEqual([[7, 7]])
  })

  test('topic words are whole concepts, not fragments of common words', () => {
    expect(topicsOf('const author = meta.author').includes('authentication')).toBe(false)
    expect(topicsOf('await state.update(s => s)').includes('database')).toBe(false)
    expect(topicsOf('const key = hash(text)').includes('security')).toBe(false)
    expect(topicsOf('if (!(await verifyPassword(password, user.passwordHash)))').includes('authentication')).toBe(true)
  })

  test('the static card points a changed method at its changed lines, not at its whole enclosing class', () => {
    const body = Array.from({ length: 60 }, (_, i) => `    const v${i} = ${i}`).join('\n')
    const before = `export class App {\n  start() {\n${body}\n    return 1\n  }\n}\n`
    const after = before.replace('return 1', 'return 2')
    const changes = [{ path: 'src/app.js', before, after, snippets: [], tools: ['Edit'], at: 0 }]
    const card = staticCard({ changes, analyses: changes.map(analyzeChange), diffs: diffBatch(changes) }, new Map(), 'c1', 0)
    expect(card.title).toBe('Changed: start()')
    expect(card.steps!.map(s => [s.text, s.ref.line, s.code])).toEqual([['Changed method start(), line 63.', 63, '    return 2']])
  })

  test('the static card names routes without call parentheses and each name once', () => {
    const before = "app.get('/a', a)\napp.get('/a', b)\n"
    const after = "app.get('/a', a2)\napp.get('/a', b2)\n"
    const changes = [{ path: 'server/app.js', before, after, snippets: [], tools: ['Edit'], at: 0 }]
    const card = staticCard({ changes, analyses: changes.map(analyzeChange), diffs: diffBatch(changes) }, new Map(), 'c1', 0)
    expect(card.title.includes('()')).toBe(false)
    expect(card.title.split('GET /a').length - 1 <= 1).toBe(true)
  })

  test('a change outside any function still gets a step at its lines', () => {
    const changes = [{ path: 'src/config.js', before: 'const a = 1\nconst b = 2\n', after: 'const a = 1\nconst b = 3\n', snippets: [], tools: ['Edit'], at: 0 }]
    const card = staticCard({ changes, analyses: changes.map(analyzeChange), diffs: diffBatch(changes) }, new Map(), 'c1', 0)
    expect(card.steps!.map(s => [s.text, s.ref.path, s.ref.line, s.code])).toEqual([['Changed line 2.', 'src/config.js', 2, 'const b = 3']])
  })

  test('a member call on some other object is not a call to a same-named plain function', () => {
    const index = buildIndex([
      { path: 'src/app.js', text: 'function run() {\n  return 1\n}\n' },
      { path: 'src/repo.js', text: "function probe(host) {\n  return host.run(['git'])\n}\n" },
    ])
    expect(callersOf(index, lookup(index, 'run')!).map(e => e.from.name)).toEqual([])
  })

  test('replies with trailing commas, raw newlines or a stray {} still parse', () => {
    expect(extractJson('{"a": [1, 2,], "b": "x",}')).toEqual({ a: [1, 2], b: 'x' })
    expect(extractJson('{"summary": "line one\nline two"}')).toEqual({ summary: 'line one\nline two' })
    expect(extractJson('Use `{}` as the default. {"title": "T"}')).toEqual({ title: 'T' })
  })

  test('a reply cut off mid-JSON is recognised, fenced or after prose, and its finished fields are kept', () => {
    expect(parseReply('```json\n{"title": "T", "summary": "S done.", "steps": [{"say": "Fir')).toEqual({ json: { title: 'T', summary: 'S done.' }, isCutOff: true })
    expect(parseReply('Here it is:\n{"worth_explaining": false, "title": "T", "summ')).toEqual({ json: { worth_explaining: false, title: 'T' }, isCutOff: true })
    expect(parseReply('{"summary": "The agent added')).toEqual({ json: null, isCutOff: true })
    expect(parseReply('The agent added a helper.')).toEqual({ json: null, isCutOff: false })
    expect(parseReply('{"title": "T"}')).toEqual({ json: { title: 'T' }, isCutOff: false })
  })
})
