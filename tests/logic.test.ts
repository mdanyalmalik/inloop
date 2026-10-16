import { describe, expect, test } from 'claude-code/testing'

import { analyzeChange, extractSymbols, findCalls, matchesFocus } from '../src/analysis'
import { Batcher, hash } from '../src/batcher'
import { changedLines, unifiedDiff } from '../src/diff'
import { describeFlow, extractJson, speakable, staticCard, diffBatch } from '../src/explain'
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
