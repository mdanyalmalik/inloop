import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { unifiedDiff } from '../src/diff'
import { DEMO_HEAD } from './fixtures'
import { ROOT, start, world, type World } from './harness'

type Edit = { file_path: string; old_string: string; new_string: string }

/**
 * The bottom of tool.call: applies Edit and Write to the virtual files, as the
 * tools would, answering with core's records (the file as it was before).
 */
function tools(on: On, w: World): void {
  on('tool.call', ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const rel = String(input.file_path).slice(ROOT.length + 1)
    const originalFile = w.files.get(rel) ?? null
    if (String(e.tool) === 'Write') {
      w.files.set(rel, String(input.content))
      return { result: { type: originalFile === null ? 'create' : 'update', filePath: input.file_path, content: input.content, structuredPatch: [], originalFile }, text: `wrote ${rel}` } as never
    }
    if (String(e.tool) === 'Edit') {
      const held = originalFile ?? ''
      const [old, now] = [String(input.old_string), String(input.new_string)]
      w.files.set(rel, input.replace_all === true ? held.split(old).join(now) : held.replace(old, () => now))
      return { result: { filePath: input.file_path, oldString: old, newString: now, originalFile, structuredPatch: [], userModified: false, replaceAll: input.replace_all === true }, text: `edited ${rel}` } as never
    }
    return { result: {}, text: 'ok' } as never
  })
}


const REFRESH = `

function refreshToken(token) {
  const claims = verifyToken(token)
  if (!claims) return null
  return jwt.sign({ sub: claims.sub, email: claims.email }, SECRET, { expiresIn: LIFETIME })
}
`

const editTokens = (): Edit => ({
  file_path: `${ROOT}/server/auth/tokens.js`,
  old_string: 'module.exports = { createToken, verifyToken }',
  new_string: REFRESH.trimStart() + '\nmodule.exports = { createToken, verifyToken, refreshToken }',
})

/** A small change: one more table in the in-memory store. */
const editTables = (): Edit => ({
  file_path: `${ROOT}/server/db/index.js`,
  old_string: 'const tables = { users: [] }',
  new_string: 'const tables = { users: [], sessions: [] }',
})

describe('automatic explanations', () => {
  test('a new function gets a card without anyone asking', async ($, on) => {
    const w = world(on, () => JSON.stringify({
      worth_explaining: true,
      title: 'Token refresh',
      concept: 'JWT refresh',
      summary: 'The agent added `refreshToken`, which re-issues a token.',
      key_lines: [{ path: 'server/auth/tokens.js', line: 19, end_line: 23, label: 'refreshToken' }, { path: 'nowhere.js', line: 1 }],
    }))
    tools(on, w)
    await start($)
    const ran = await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    // The agent's tool result passes through untouched.
    expect((ran as { text?: string }).text).toBe('edited server/auth/tokens.js')
    expect(w.get('cards') ?? []).toEqual([])
    await w.clock.advance(10_000)
    const cards = w.get('cards') ?? []
    expect(cards.length).toBe(1)
    const card = cards[0]!
    expect(card.title).toBe('Token refresh')
    expect(card.symbols.includes('refreshToken')).toBe(true)
    // Refs to files that do not exist are dropped.
    expect(card.refs).toEqual([{ path: 'server/auth/tokens.js', line: 19, endLine: 23, rev: undefined, label: undefined }])
    expect(card.steps?.map(st => st.text)).toEqual(['refreshToken'])
    expect(card.diff?.includes('+function refreshToken(token) {')).toBe(true)
    // The model saw the diff and the static facts, framed as untrusted data, and never the .env secret.
    const p = w.prompts[0]!
    expect(p.model).toBe('haiku')
    expect(p.prompt.includes('<repo_data source="server/auth/tokens.js">')).toBe(true)
    expect(p.prompt.includes('refreshToken')).toBe(true)
    expect(p.system.includes('untrusted data')).toBe(true)
    expect(w.prompts.some(x => x.prompt.includes('never-read-this-value'))).toBe(false)
    expect(w.reads.includes('.env')).toBe(false)
    expect(w.writes).toEqual([])
  })

  test('related edits across files become one card', async ($, on) => {
    const w = world(on)
    tools(on, w)
    await start($)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(1000)
    await $.tool.call({
      tool: 'Write',
      file_path: `${ROOT}/server/auth/refresh.js`,
      content: "const { refreshToken } = require('./tokens')\n\nasync function refresh(req, res) {\n  const token = refreshToken(req.body.token)\n  if (!token) return res.status(401).end()\n  res.json({ token })\n}\n\nmodule.exports = { refresh }\n",
    } as never)
    await w.clock.advance(1000)
    await $.tool.call({
      tool: 'Edit',
      file_path: `${ROOT}/server/app.js`,
      old_string: "app.post('/api/register', register)",
      new_string: "app.post('/api/register', register)\napp.post('/api/refresh', refresh)",
    } as never)
    await w.clock.advance(10_000)
    const cards = w.get('cards') ?? []
    expect(cards.length).toBe(1)
    expect([...cards[0]!.files].sort()).toEqual(['server/app.js', 'server/auth/refresh.js', 'server/auth/tokens.js'])
    expect(w.prompts.length).toBe(1)
  })

  test('a comment-only edit is not explained and costs nothing', async ($, on) => {
    const w = world(on)
    tools(on, w)
    await start($)
    await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/server/db/index.js`, old_string: 'const tables', new_string: '// in-memory tables\nconst tables' } as never)
    await w.clock.advance(10_000)
    // Not explained, but not hidden either: one line says so.
    expect((w.get('cards') ?? []).map(c => c.skipped)).toEqual(['only whitespace or comments changed'])
    expect(w.prompts.length).toBe(0)
  })

  test('a small change gets a short explanation with one part, not "not explained"', async ($, on) => {
    const w = world(on, () => JSON.stringify({
      worth_explaining: true,
      title: 'Sessions table',
      summary: 'The in-memory store gains a sessions table.',
      steps: [
        { say: 'The new table.', path: 'server/db/index.js', line: 2, end_line: 2 },
        { say: 'A second part.', path: 'server/db/index.js', line: 4, end_line: 6 },
      ],
    }))
    tools(on, w)
    await start($)
    await $.tool.call({ tool: 'Edit', ...editTables() } as never)
    await w.clock.advance(10_000)
    const card = (w.get('cards') ?? [])[0]!
    expect(card.skipped).toBeUndefined()
    expect(card.isBrief).toBe(true)
    expect(card.steps?.length).toBe(1)
    expect(w.prompts.at(-1)!.prompt).toContain('a small change')
    expect(w.prompts.at(-1)!.prompt).toContain('1-2 sentences')
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    expect(await ui.find({ text: /Sessions table · small change/ })).toBeDefined()
    await ui.unmount()
  })

  test('focus mode skips changes off the topic', async ($, on) => {
    const w = world(on)
    tools(on, w)
    await start($)
    await $.command.run({ command: 'inloop-focus', args: 'database queries' } as never)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    expect((w.get('cards') ?? []).map(c => c.skipped)).toEqual(['not about "database queries"'])
    expect(w.prompts.length).toBe(0)
  })

  test('a skipped change shows as one line, and "explain anyway" explains it in its place', async ($, on) => {
    const w = world(on, () => JSON.stringify({ worth_explaining: true, title: 'Tables comment', summary: 'A comment names the tables.', steps: [] }))
    tools(on, w)
    await start($)
    await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/server/db/index.js`, old_string: 'const tables', new_string: '// in-memory tables\nconst tables' } as never)
    await w.clock.advance(10_000)
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    expect(await ui.find({ text: /not explained · Edited server\/db\/index\.js/ })).toBeDefined()
    expect(await ui.find({ text: /1 not explained/ })).toBeDefined()
    // Never read aloud, never saved to history.
    expect(w.get('history') ?? []).toEqual([])
    const id = (w.get('cards') ?? [])[0]!.id
    await ui.press({ key: `feed:again:${id}` })
    await w.clock.advance(10_000)
    const cards = w.get('cards') ?? []
    expect(cards.length).toBe(1)
    expect(cards[0]!.title).toBe('Tables comment')
    expect(cards[0]!.skipped).toBeUndefined()
    await ui.unmount()
  })

  test('"explain anyway" explains even when the model would call the change too minor', async ($, on) => {
    const w = world(on, () => JSON.stringify({ worth_explaining: false, title: 'Tables comment', summary: 'A comment names the tables.', steps: [] }))
    tools(on, w)
    await start($)
    await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/server/db/index.js`, old_string: 'const tables', new_string: '// in-memory tables\nconst tables' } as never)
    await w.clock.advance(10_000)
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    await ui.press({ key: `feed:again:${(w.get('cards') ?? [])[0]!.id}` })
    await w.clock.advance(10_000)
    expect((w.get('cards') ?? []).map(c => [c.title, c.skipped])).toEqual([['Tables comment', undefined]])
    await ui.unmount()
  })

  test('several edits to one file that land together are all in its explanation', async ($, on) => {
    const w = world(on)
    tools(on, w)
    await start($)
    // Parallel tool calls: every edit is in the file before inloop reads it.
    await Promise.all([
      $.tool.call({ tool: 'Edit', ...editTokens() } as never),
      $.tool.call({ tool: 'Edit', file_path: `${ROOT}/server/auth/tokens.js`, old_string: "const LIFETIME = '1h'", new_string: "const LIFETIME = '15m'" } as never),
    ])
    await w.clock.advance(10_000)
    const diff = (w.get('cards') ?? [])[0]!.diff ?? ''
    expect(diff.includes('+function refreshToken(token) {')).toBe(true)
    expect(diff.includes("+const LIFETIME = '15m'")).toBe(true)
    expect(diff.includes("-const LIFETIME = '1h'")).toBe(true)
  })

  test('a reply cut off mid-JSON is a failed explanation, never shown raw', async ($, on) => {
    const w = world(on, () => '{"worth_explaining": true, "title": "Token refresh", "summary": "The agent added')
    tools(on, w)
    await start($)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    const cards = w.get('cards') ?? []
    expect(cards.map(c => c.failed)).toEqual(['the reply was cut off'])
    expect(cards[0]!.summary.includes('worth_explaining')).toBe(false)
    expect(w.get('history') ?? []).toEqual([])
  })

  for (const [shape, reply] of [
    ['fenced', '```json\n{"worth_explaining": true, "title": "Token refresh", "summary": "The agent added'],
    ['after prose', 'Here is the card:\n{"worth_explaining": true, "title": "Token refresh", "summary": "The agent added'],
  ] as const) {
    test(`a cut-off reply ${shape} is a failed explanation too, never shown raw`, async ($, on) => {
      const w = world(on, () => reply)
      tools(on, w)
      await start($)
      await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
      await w.clock.advance(10_000)
      const cards = w.get('cards') ?? []
      expect(cards.map(c => c.failed)).toEqual(['the reply was cut off'])
      expect(cards[0]!.summary.includes('worth_explaining')).toBe(false)
    })
  }

  test('"try again" after a cut-off reply asks the model again; one cut off after its summary keeps the summary', async ($, on) => {
    let calls = 0
    const w = world(on, () => {
      calls++
      return calls === 1
        ? '{"worth_explaining": true, "title": "Token refresh", "summary": "The agent added'
        : '{"worth_explaining": true, "title": "Token refresh", "summary": "The agent added a refresh helper.", "steps": [{"say": "First the'
    })
    tools(on, w)
    await start($)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    const failed = (w.get('cards') ?? [])[0]!
    expect(failed.failed).toBe('the reply was cut off')
    // A cut-off reply is never served again from the cache.
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    await ui.press({ key: `feed:card:${failed.id}` })
    await ui.press({ key: `feed:again:${failed.id}` })
    await w.clock.advance(10_000)
    expect(calls).toBe(2)
    const card = (w.get('cards') ?? [])[0]!
    expect([card.title, card.summary, card.failed]).toEqual(['Token refresh', 'The agent added a refresh helper.', undefined])
    await ui.unmount()
  })

  test('in focus mode, worth_explaining written as the string "false" still skips', async ($, on) => {
    const w = world(on, () => '{"worth_explaining": "false", "title": "x", "summary": "y"}', { settings: { style: 'written', mode: 'focus', focus: 'tokens' } })
    tools(on, w)
    await start($)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    expect((w.get('cards') ?? []).map(c => c.skipped)).toEqual(['not about "tokens"'])
  })

  test('the model calling a change minor still explains it: only focus mode leaves one out', async ($, on) => {
    const w = world(on, () => JSON.stringify({ worth_explaining: false, title: 'Token check', summary: 'Checks the token first.' }))
    tools(on, w)
    await start($)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    const cards = w.get('cards') ?? []
    expect(cards.map(c => c.skipped)).toEqual([undefined])
    expect(cards[0]!.summary).toBe('Checks the token first.')
  })

  test('a failed model call says so plainly, with the changes and "try again"', async ($, on) => {
    const w = world(on)
    w.failModel = () => ({ reason: 'api-error', status: 400, error: 'bad request' })
    tools(on, w)
    await start($)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    // A request the API refuses is not one waiting cures: no retries.
    expect(w.prompts.length).toBe(1)
    const card = (w.get('cards') ?? [])[0]!
    expect(card.failed).toBe('API error 400 bad request')
    expect(card.steps).toEqual([])
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    expect(await ui.find({ text: /⚠ explanation failed/ })).toBeDefined()
    await ui.press({ key: `feed:card:${card.id}` })
    expect(await ui.find({ text: /server\/auth\/tokens\.js/ })).toBeDefined()
    w.failModel = () => undefined
    await ui.press({ key: `feed:again:${card.id}` })
    await w.clock.advance(10_000)
    expect((w.get('cards') ?? [])[0]!.failed).toBeUndefined()
    await ui.unmount()
  })

  test('an overloaded, rate-limited or cut-off call is waited out and retried, as Claude Code does', async ($, on) => {
    const w = world(on)
    w.failModel = call => (call === 1 ? { reason: 'aborted' } : call === 2 ? { reason: 'api-error', status: 429, error: 'rate limited' } : call === 3 ? { reason: 'api-error', status: 529, error: 'overloaded' } : undefined)
    tools(on, w)
    await start($)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(60_000)
    expect(w.prompts.length).toBe(4)
    expect((w.get('cards') ?? []).map(c => c.failed)).toEqual([undefined])
  })

  test('a call that keeps failing gives up after about a minute', async ($, on) => {
    const w = world(on)
    w.failModel = () => ({ reason: 'api-error', status: 529, error: 'overloaded' })
    tools(on, w)
    await start($)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(120_000)
    expect(w.prompts.length).toBe(5)
    expect((w.get('cards') ?? []).map(c => c.failed)).toEqual(['API error 529 overloaded'])
  })

  test('"explain anyway" still works after a reload, from the diff the card carries', async ($, on) => {
    const w = world(on, () => JSON.stringify({ worth_explaining: true, title: 'Tables comment', summary: 'A comment names the tables.', steps: [] }))
    tools(on, w)
    await start($)
    await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/server/db/index.js`, old_string: 'const tables', new_string: '// in-memory tables\nconst tables' } as never)
    await w.clock.advance(10_000)
    // The plugin reloads: the feed is kept, the change behind it is not.
    await start($)
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    await ui.press({ key: `feed:again:${(w.get('cards') ?? [])[0]!.id}` })
    await w.clock.advance(10_000)
    expect((w.get('cards') ?? []).map(c => [c.title, c.skipped])).toEqual([['Tables comment', undefined]])
    expect(w.prompts.at(-1)?.prompt.includes('+// in-memory tables')).toBe(true)
    expect(w.get('status')?.lastError).toBeUndefined()
    await ui.unmount()
  })

  test('pressing "explain anyway" twice before the pane redraws explains once, with no error', async ($, on) => {
    const w = world(on, () => JSON.stringify({ worth_explaining: true, title: 'Tables comment', summary: 'A comment names the tables.', steps: [] }))
    tools(on, w)
    await start($)
    await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/server/db/index.js`, old_string: 'const tables', new_string: '// in-memory tables\nconst tables' } as never)
    await w.clock.advance(10_000)
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    const id = (w.get('cards') ?? [])[0]!.id
    await ui.press({ key: `feed:again:${id}` })
    await ui.press({ key: `feed:again:${id}` })
    await w.clock.advance(10_000)
    expect((w.get('cards') ?? []).map(c => c.title)).toEqual(['Tables comment'])
    expect(w.prompts.length).toBe(1)
    expect(w.get('status')?.lastError).toBeUndefined()
    await ui.unmount()
  })

  test('the busy line stays while a question runs, though an explanation started beside it is done', async ($, on) => {
    const w = world(on, prompt => (prompt.includes('in-memory tables')
      ? JSON.stringify({ worth_explaining: true, title: 'Tables comment', summary: 'A comment names the tables.', steps: [] })
      : JSON.stringify({ answer: 'It checks the password.', refs: [] })))
    tools(on, w)
    let release = (): void => undefined
    w.holdModel = prompt => (prompt.includes('in-memory tables') ? undefined : new Promise<void>(resolve => { release = resolve }))
    await start($)
    await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/server/db/index.js`, old_string: 'const tables', new_string: '// in-memory tables\nconst tables' } as never)
    await w.clock.advance(10_000)
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    const id = (w.get('cards') ?? [])[0]!.id
    await $.command.run({ command: 'inloop', args: 'how does login work' } as never)
    await w.clock.advance(10)
    await ui.press({ key: 'tab:feed' })
    await ui.press({ key: `feed:again:${id}` })
    await w.clock.advance(10)
    expect((w.get('cards') ?? [])[0]!.title).toBe('Tables comment')
    // The question is still being answered: its spinner and line stay.
    expect(w.get('status')?.busy).toBe('investigating')
    expect(await ui.find({ text: /investigating/ })).toBeDefined()
    release()
    await w.clock.advance(10_000)
    expect(w.get('status')?.busy).toBe(null)
    await ui.unmount()
  })

  test('paused mode records but does not explain; explain-recent does', async ($, on) => {
    const w = world(on)
    tools(on, w)
    await start($)
    await $.command.run({ command: 'inloop-mode', args: 'paused' } as never)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    expect(w.get('cards') ?? []).toEqual([])
    await $.command.run({ command: 'inloop-recent', args: '5' } as never)
    await w.clock.advance(100)
    const cards = w.get('cards') ?? []
    expect(cards.length).toBe(1)
    expect(cards[0]!.title.startsWith('Last 5 min')).toBe(true)
  })

  test('edits to secrets files are never read', async ($, on) => {
    const w = world(on)
    tools(on, w)
    await start($)
    await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/.env`, old_string: 'JWT_SECRET', new_string: 'JWT_SECRET2' } as never)
    await w.clock.advance(10_000)
    expect(w.reads.includes('.env')).toBe(false)
    expect(w.get('cards') ?? []).toEqual([])
  })
})

describe('questions and flows', () => {
  test('a flow question draws the real login flow and keeps scope', async ($, on) => {
    const w = world(on, prompt => {
      if (prompt.includes('Lookups so far')) {
        return JSON.stringify({
          answer: 'Pressing **Log in** runs `handleLogin`, which posts to `/api/login`; `login` checks the password and returns a token from `createToken`.',
          refs: [{ path: 'server/auth/controller.js', line: 5, end_line: 14, label: 'login' }, { path: 'made/up.js', line: 3 }],
          flow: { entry: 'LoginForm', path: ['LoginForm', 'handleLogin', 'loginRequest', 'POST /api/login', 'login', 'imaginaryStep'] },
          scope: 'the login flow',
        })
      }
      return JSON.stringify({ lookups: [{ lookup: 'symbol', name: 'login' }] })
    })
    tools(on, w)
    await start($)
    await $.command.run({ command: 'inloop-flow', args: 'what happens when a user logs in' } as never)
    await w.clock.advance(100)
    const flow = w.get('flow')
    expect(flow).toBeDefined()
    const labels = flow!.nodes.map(n => n.label)
    expect(labels.includes('handleLogin()')).toBe(true)
    expect(labels.includes('createToken()')).toBe(true)
    expect(labels.some(l => l.includes('imaginaryStep'))).toBe(false)
    expect(flow!.notes.some(n => n.includes('imaginaryStep'))).toBe(true)
    // The lookup ran and its result went back to the model.
    expect(w.prompts.some(p => p.prompt.includes('Callers: POST /api/login'))).toBe(true)
    // The explanation is in the Flow tab, with its diagram; the Ask tab and the Code tab are left alone.
    expect(w.get('answers').flow?.a?.refs?.map(r => r.path)).toEqual(['server/auth/controller.js'])
    expect(w.get('convo') ?? []).toEqual([])
    expect(w.get('viewer') ?? null).toBe(null)
    expect(w.get('ctx')?.scope).toBe('the login flow')
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    expect(w.get('tab')).toBe('flow')
    expect(await ui.find({ text: /runs `?handleLogin/ })).toBeDefined()
    await ui.unmount()
  })

  test('a traced flow shows its steps in order with what each does; one that finds nothing draws nothing', async ($, on) => {
    const w = world(on, prompt => {
      if (prompt.includes('logs out')) return JSON.stringify({ answer: 'There is no logout in this code: nothing ends a session.', refs: [], steps: [], flow: null })
      return JSON.stringify({
        answer: 'Pressing **Log in** posts the form; the server checks the password and signs a token.',
        refs: [],
        steps: [],
        flow: { path: [{ name: 'handleLogin', does: 'sends email and password' }, { name: 'POST /api/login', does: 'the login route' }, { name: 'login', does: 'checks the password' }, { name: 'createToken', does: 'signs the token' }] },
      })
    })
    tools(on, w)
    await start($)
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    await $.command.run({ command: 'inloop-flow', args: 'what happens when a user logs in' } as never)
    await w.clock.advance(100)
    expect(w.get('flow')?.isDraft).not.toBe(true)
    expect(await ui.find({ text: /1\. handleLogin\(\)/ })).toBeDefined()
    expect(await ui.find({ text: /sends email and password/ })).toBeDefined()
    expect(await ui.find({ text: /calls it through loginRequest/ })).toBeDefined()
    // A feature that is not in the code: the first draw from its words goes, and the tab says no diagram was drawn.
    await $.command.run({ command: 'inloop-flow', args: 'what happens when a user logs out of the login session' } as never)
    expect(w.get('flow')?.isDraft).toBe(true)
    await w.clock.advance(100)
    expect(w.get('flow') ?? null).toBe(null)
    expect(await ui.find({ text: /No diagram could be drawn/ })).toBeDefined()
    expect(await ui.find({ text: /no logout in this code/ })).toBeDefined()
    await ui.unmount()
  })

  test('each tab answers in place: go deeper inside the explanation, explain these lines in Code', async ($, on) => {
    const w = world(on, prompt => {
      if (prompt.includes('Go deeper')) return JSON.stringify({ answer: 'Deeper: the token is signed with the server secret.', refs: [], steps: [] })
      if (prompt.includes('Explain lines')) return JSON.stringify({ answer: 'These lines check the password.', refs: [], steps: [] })
      return JSON.stringify({ worth_explaining: true, title: 'Token refresh', summary: 'The agent added `refreshToken`.', steps: [{ say: 'The new helper.', path: 'server/auth/tokens.js', line: 18, end_line: 22 }] })
    })
    tools(on, w)
    await start($)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    const card = w.get('cards')[0]!
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    await ui.press({ key: `feed:deeper:${card.id}` })
    await w.clock.advance(100)
    expect(w.get('tab') ?? 'feed').toBe('feed')
    expect(w.get('answers').cards[card.id]?.a?.text).toContain('Deeper')
    expect(await ui.find({ text: /Deeper: the token/ })).toBeDefined()
    expect(w.get('convo') ?? []).toEqual([])
    await ui.press({ key: `feed:deeper:${card.id}:close` })
    expect(w.get('answers').cards[card.id]).toBe(undefined)

    await ui.press({ key: `feed:step:${card.id}:0:open` })
    expect(w.get('tab')).toBe('code')
    await ui.press({ key: 'code:ask' })
    await w.clock.advance(100)
    expect(w.get('tab')).toBe('code')
    expect(await ui.find({ text: /These lines check the password/ })).toBeDefined()
    expect(w.get('viewer')?.line).toBe(18)
    expect(w.get('convo') ?? []).toEqual([])
    await ui.unmount()
  })
})

const PANE_PROPS = {
  title: 'inloop',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { top: 0, bodyRows: 40 },
  view: {},
} as const

describe('pane', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`draws, switches tabs and navigates from a flow node (${surface})`, async ($, on) => {
      const w = world(on, prompt => (prompt.includes('explain what this one step does') ? 'This step checks the password.' : JSON.stringify({ answer: 'ok', refs: [], flow: { entry: 'login' }, scope: '' })))
      tools(on, w)
      await start($)
      const ui = await $.ui.mount({ plugin: 'inloop', surface, component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
      expect(await ui.find({ text: /each meaningful step appears here|explanation/ })).toBeDefined()
      await ui.press({ key: 'tab:flow' })
      expect(await ui.find({ text: /No flow yet/ })).toBeDefined()
      await ui.input({ key: 'flowq', text: 'what does login do' })
      await w.clock.advance(100)
      const node = await ui.find({ key: 'node:n0' })
      expect(node).toBeDefined()
      await ui.press({ key: 'node:n0' })
      await w.clock.advance(100)
      expect(w.get('viewer')?.path).toBe('server/auth/controller.js')
      expect(await ui.find({ text: /checks the password/ })).toBeDefined()
      await ui.press({ key: 'tab:code' })
      expect(await ui.find({ text: /server\/auth\/controller\.js/ })).toBeDefined()
      expect(await ui.find({ text: /working tree/ })).toBeDefined()
      await ui.unmount()
    })
  }
})

describe('history', () => {
  test('cards merge with what other sessions stored; bookmarks survive a clear', async ($, on) => {
    const other = { id: 'other1', at: 1, title: 'From another session', summary: 'x', files: [], symbols: [], refs: [], source: 'auto' }
    const w = world(on, undefined, { history: [other] })
    tools(on, w)
    await start($)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    const stored = w.stored.get('history') as { id: string; title: string }[]
    expect(stored.length).toBe(2)
    expect(stored.some(c => c.id === 'other1')).toBe(true)
    const mine = (w.get('cards') ?? [])[0]!
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    // The newest explanation is already open.
    await ui.press({ key: `feed:bm:${mine.id}` })
    expect((w.get('history') ?? []).find(c => c.id === mine.id)?.bookmarked).toBe(true)
    await ui.press({ key: 'tab:history' })
    await ui.press({ key: 'hist:clear' })
    const after = w.stored.get('history') as { id: string }[]
    expect(after.map(c => c.id)).toEqual([mine.id])
    await ui.unmount()
  })

  test('one explanation can be deleted from History, and stays deleted', async ($, on) => {
    const other = { id: 'other1', at: 1, title: 'From another session', summary: 'x', files: [], symbols: [], refs: [], source: 'auto' }
    const w = world(on, undefined, { history: [other] })
    tools(on, w)
    await start($)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    const mine = (w.get('cards') ?? [])[0]!
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    await ui.press({ key: 'tab:history' })
    // The newest explanation is open; its delete removes it everywhere, the other stays.
    await ui.press({ key: `history:delete:${mine.id}` })
    expect((w.get('history') ?? []).map(c => c.id)).toEqual(['other1'])
    expect((w.stored.get('history') as { id: string }[]).map(c => c.id)).toEqual(['other1'])
    expect((w.get('cards') ?? []).some(c => c.id === mine.id)).toBe(false)
    expect(await ui.find({ text: /1 saved explanations/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('surfaces without fields', () => {
  test('mobile draws the feed and points to commands instead of an input', async ($, on) => {
    const w = world(on)
    tools(on, w)
    await start($)
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'mobile', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    // Questions belong to the Ask tab: the feed has no question box or pointer.
    expect(await ui.find({ text: /\/inloop <question>/ })).toBe(undefined)
    await ui.press({ key: 'tab:ask' })
    expect(await ui.find({ text: /\/inloop <question>/ })).toBeDefined()
    await ui.press({ key: 'tab:settings' })
    expect(await ui.find({ text: /inloop-mode/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('lifecycle', () => {
  for (const reason of ['clear', 'resume'] as const) {
    test(`after /${reason} (a session.end with no session.start), changes are still explained`, async ($, on) => {
      const w = world(on)
      tools(on, w)
      on('session.end', () => ({ sessionId: 's1' }) as never)
      await start($)
      await $.session.end({ reason } as never)
      await w.clock.advance(1)
      await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
      await w.clock.advance(10_000)
      const cards = w.get('cards') ?? []
      expect(cards.length).toBe(1)
      expect(cards[0]!.skipped).toBeUndefined()
      expect(cards[0]!.failed).toBeUndefined()
      expect(w.prompts.length).toBe(1)
    })
  }

  test('/inloop-reload lets a hung scan go and explains what was missed', async ($, on) => {
    const w = world(on)
    tools(on, w)
    await start($)
    // A git call that never returns leaves the scan hanging: later scans wait on it.
    w.isGitStatusHung = true
    w.files.set('server/app.js', w.files.get('server/app.js')! + '\nfunction health(req, res) {\n  res.json({ ok: true })\n}\n')
    await $.tool.call({ tool: 'Bash', command: 'python3 fix.py' } as never)
    await w.clock.advance(10_000)
    expect((w.get('cards') ?? []).length).toBe(0)
    w.isGitStatusHung = false
    await $.command.run({ command: 'inloop-reload', args: '' } as never)
    await w.clock.advance(10_000)
    const cards = w.get('cards') ?? []
    expect(cards.map(c => c.files)).toEqual([['server/app.js']])
    expect(w.toasts.some(t => /inloop restarted/.test(t))).toBe(true)
    // The hung call returns at last; nothing is explained twice.
    w.releaseGit()
    await w.clock.advance(10_000)
    expect((w.get('cards') ?? []).length).toBe(1)
  })

  test('a second session.start (a reload) does not double-process edits', async ($, on) => {
    const w = world(on)
    tools(on, w)
    await start($)
    await start($)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    expect((w.get('cards') ?? []).length).toBe(1)
    expect(w.prompts.length).toBe(1)
  })

  test('a change undone and then made again is shown again, not dropped as already seen', async ($, on) => {
    const w = world(on)
    tools(on, w)
    await start($)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    const e = editTokens()
    await $.tool.call({ tool: 'Edit', file_path: e.file_path, old_string: e.new_string, new_string: e.old_string } as never)
    await w.clock.advance(10_000)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    const cards = w.get('cards') ?? []
    // Otherwise the feed would end on the undo, as if the change were gone.
    expect(cards.length).toBe(3)
    expect(cards[0]!.diff?.includes('+function refreshToken(token) {')).toBe(true)
  })

  test('many rapid edits stay bounded: batches fold instead of queueing without limit', async ($, on) => {
    const w = world(on)
    tools(on, w)
    await start($)
    for (let i = 0; i < 12; i++) {
      await $.tool.call({
        tool: 'Write',
        file_path: `${ROOT}/server/gen/f${i}.js`,
        content: `function generated${i}(a, b) {\n  return a + b + ${i}\n}\n\nmodule.exports = { generated${i} }\n`,
      } as never)
      await w.clock.advance(7000)
    }
    await w.clock.advance(60_000)
    // Twelve separate steps, at most one model call each, and never more cards than steps.
    expect(w.prompts.length <= 12).toBe(true)
    expect((w.get('cards') ?? []).length <= 12).toBe(true)
    expect((w.get('cards') ?? []).length >= 1).toBe(true)
  })
})

describe('changes made outside the edit tools', () => {
  test('each automatic explanation lists its files, lines changed, and opens a file diff', async ($, on) => {
    const w = world(on)
    tools(on, w)
    await start($)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    const card = (w.get('cards') ?? [])[0]!
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    expect(await ui.find({ text: /server\/auth\/tokens\.js/ })).toBeDefined()
    expect(await ui.find({ text: /\+7/ })).toBeDefined()
    expect(await ui.find({ text: /lines 18-24/ })).toBeDefined()
    await ui.press({ key: `feed:chg:${card.id}:0` })
    expect(w.get('tab')).toBe('code')
    expect(w.get('viewer')?.path).toBe('server/auth/tokens.js')
    expect(w.get('viewer')?.diff?.startsWith('@@')).toBe(true)
    await ui.unmount()
  })

  test('files changed by a shell command are explained like edits', async ($, on) => {
    const w = world(on)
    tools(on, w)
    await start($)
    // The agent rewrites two files with a script run through Bash.
    const controller = w.files.get('server/auth/controller.js')!
    w.files.set('server/auth/controller.js', controller + '\nasync function logout(req, res) {\n  res.status(204).end()\n}\n')
    w.files.set('server/middleware/rateLimit.js', 'function rateLimit(req, res, next) {\n  next()\n}\n\nmodule.exports = { rateLimit }\n')
    await $.tool.call({ tool: 'Bash', command: 'python3 - <<EOF ... EOF' } as never)
    await w.clock.advance(10_000)
    const cards = w.get('cards') ?? []
    expect(cards.length).toBe(1)
    expect([...cards[0]!.files].sort()).toEqual(['server/auth/controller.js', 'server/middleware/rateLimit.js'])
    expect(cards[0]!.diff?.includes('+async function logout(req, res) {')).toBe(true)
    // Nothing changed by the next command: nothing more to explain.
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    await w.clock.advance(10_000)
    expect((w.get('cards') ?? []).length).toBe(1)
  })

  test('a script that changes a file the agent already edited is still explained', async ($, on) => {
    const w = world(on)
    tools(on, w)
    await start($)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await $.tool.call({ tool: 'Bash', command: 'npx tsc' } as never)
    await w.clock.advance(10_000)
    expect((w.get('cards') ?? []).length).toBe(1)
    const tokens = w.files.get('server/auth/tokens.js')!
    w.files.set('server/auth/tokens.js', tokens.replace('module.exports', 'function revokeToken(token) {\n  return revoked.add(token)\n}\n\nmodule.exports'))
    await $.tool.call({ tool: 'Bash', command: 'python3 - <<EOF ... EOF' } as never)
    await w.clock.advance(10_000)
    const cards = w.get('cards') ?? []
    expect(cards.length).toBe(2)
    expect(cards[0]!.diff?.includes('+function revokeToken(token) {')).toBe(true)
    expect(cards[0]!.diff?.includes('+function refreshToken(token) {')).toBe(false)
  })

  test("uncommitted work from before the session is the person's, never explained", async ($, on) => {
    const w = world(on)
    tools(on, w)
    w.files.set('server/db/users.js', w.files.get('server/db/users.js')! + '\n// my own work in progress\nfunction draft() {\n  return 1\n}\n')
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
    await w.clock.advance(10_000)
    expect((w.get('cards') ?? []).length).toBe(0)
    // A change the agent then makes to another file is explained alone.
    w.files.set('server/app.js', w.files.get('server/app.js')! + '\nfunction health(req, res) {\n  res.json({ ok: true })\n}\n')
    await $.tool.call({ tool: 'Bash', command: 'sed -i ...' } as never)
    await w.clock.advance(10_000)
    const cards = w.get('cards') ?? []
    expect(cards.length).toBe(1)
    expect(cards[0]!.files).toEqual(['server/app.js'])
  })

  test('a script that edits and commits in one command is still seen', async ($, on) => {
    const w = world(on)
    tools(on, w)
    await start($)
    w.files.set('server/app.js', w.files.get('server/app.js')! + '\nfunction health(req, res) {\n  res.json({ ok: true })\n}\n')
    w.commit()
    await $.tool.call({ tool: 'Bash', command: 'python3 fix.py && git commit -am "health"' } as never)
    await w.clock.advance(10_000)
    const cards = w.get('cards') ?? []
    expect(cards.length).toBe(1)
    expect(cards[0]!.diff?.includes('+function health(req, res) {')).toBe(true)
  })

  test('a virtual environment full of files is never taken for changes', async ($, on) => {
    const w = world(on)
    for (let i = 0; i < 400; i++) w.files.set(`.venv-qi/lib/python3.12/site-packages/pkg/m${i}.py`, `def f${i}():\n    return ${i}\n`)
    tools(on, w)
    await start($)
    w.files.set('server/app.js', w.files.get('server/app.js')! + '\nfunction health(req, res) {\n  res.json({ ok: true })\n}\n')
    await $.tool.call({ tool: 'Bash', command: 'python3 fix.py' } as never)
    await w.clock.advance(10_000)
    const cards = w.get('cards') ?? []
    expect(cards.map(c => c.files)).toEqual([['server/app.js']])
    // Unchanged files are fingerprinted, not read again, on the next scan.
    const before = w.reads.length
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    await w.clock.advance(10_000)
    expect(w.reads.length).toBe(before)
  })

  test("after a restart the feed starts with this project's earlier explanations", async ($, on) => {
    const mine = { id: 'old1', at: 1000, title: 'Earlier change here', summary: 'S', files: ['server/app.js'], symbols: [], refs: [], source: 'auto', root: ROOT }
    // Untagged, though its files are here: never guessed in (a copy of another project would pass too).
    const legacy = { id: 'old2', at: 900, title: 'Untagged, files here', summary: 'S', files: ['server/auth/tokens.js'], symbols: [], refs: [], source: 'auto' }
    const other = { id: 'old3', at: 800, title: 'Another project', summary: 'S', files: ['src/x.ts'], symbols: [], refs: [], source: 'auto', root: '/elsewhere' }
    const asked = { id: 'old4', at: 700, title: 'a question', summary: 'S', files: [], symbols: [], refs: [], source: 'ask', root: ROOT }
    const w = world(on, undefined, { history: [mine, legacy, other, asked] })
    tools(on, w)
    await start($)
    expect((w.get('cards') ?? []).map(c => c.id)).toEqual(['old1'])
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    expect(await ui.find({ text: /earlier sessions/ })).toBeDefined()
    // New explanations go above them, and are tagged with this project.
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    const cards = w.get('cards') ?? []
    expect(cards.map(c => c.id).slice(1)).toEqual(['old1'])
    expect(cards[0]!.root).toBe(ROOT)
    // History keeps every project's: this one's first, the others under their folder.
    await ui.press({ key: 'tab:history' })
    expect(await ui.find({ text: /This project/ })).toBeDefined()
    expect(await ui.find({ text: /Other projects/ })).toBeDefined()
    expect(await ui.find({ text: /Another project · \/elsewhere · / })).toBeDefined()
    await ui.unmount()
  })

  test('the end of a turn catches changes no tool reported', async ($, on) => {
    const w = world(on)
    tools(on, w)
    await start($)
    w.files.set('server/auth/passwords.js', w.files.get('server/auth/passwords.js')! + '\nfunction isStrong(password) {\n  return password.length >= 12\n}\n')
    await $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 't1' } as never)
    await w.clock.advance(10_000)
    const cards = w.get('cards') ?? []
    expect(cards.length).toBe(1)
    expect(cards[0]!.files).toEqual(['server/auth/passwords.js'])
  })
})

describe('what each change was', () => {
  const CONTROLLER = `${ROOT}/server/auth/controller.js`

  test('an edit whose new text also appears earlier in the file shows where it really changed', async ($, on) => {
    const w = world(on)
    tools(on, w)
    await start($)
    const before = w.files.get('server/auth/controller.js')!
    // register now answers like login does: login already has this very line.
    await $.tool.call({ tool: 'Edit', file_path: CONTROLLER, old_string: '  res.status(201).json({ id: user.id })', new_string: '  res.json({ token })' } as never)
    await w.clock.advance(10_000)
    const diff = (w.get('cards') ?? [])[0]!.diff ?? ''
    expect(diff.includes(unifiedDiff(before, w.files.get('server/auth/controller.js')!))).toBe(true)
  })

  test('a deletion followed by another edit to the same file is not shown as a new file', async ($, on) => {
    const w = world(on)
    tools(on, w)
    await start($)
    await $.tool.call({ tool: 'Edit', file_path: CONTROLLER, old_string: "const { hashPassword, verifyPassword } = require('./passwords')\n", new_string: '' } as never)
    await w.clock.advance(1000)
    await $.tool.call({ tool: 'Edit', file_path: CONTROLLER, old_string: '  res.status(201).json({ id: user.id })', new_string: '  res.status(201).json({ id: user.id, email })' } as never)
    await w.clock.advance(10_000)
    const card = (w.get('cards') ?? [])[0]!
    expect(card.diff?.includes("-const { hashPassword, verifyPassword } = require('./passwords')")).toBe(true)
    expect(card.diff?.includes('+  res.status(201).json({ id: user.id, email })')).toBe(true)
    expect(card.diff?.includes("+const { findUserByEmail, createUser } = require('../db/users')")).toBe(false)
  })

  test('a shell command that puts a file back the way a scan last saw it is still a change', async ($, on) => {
    const w = world(on)
    tools(on, w)
    await start($)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
    await w.clock.advance(10_000)
    const tested = w.files.get('server/auth/tokens.js')!
    await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/server/auth/tokens.js`, old_string: "const LIFETIME = '1h'", new_string: "const LIFETIME = '15m'" } as never)
    await w.clock.advance(10_000)
    // The agent undoes its last edit from the shell.
    w.files.set('server/auth/tokens.js', tested)
    await $.tool.call({ tool: 'Bash', command: "sed -i \"s/'15m'/'1h'/\" server/auth/tokens.js" } as never)
    await w.clock.advance(10_000)
    const cards = w.get('cards') ?? []
    expect(cards.length).toBe(3)
    expect(cards[0]!.diff?.includes("-const LIFETIME = '15m'")).toBe(true)
  })

  test('a file a shell command deletes is a change, and shows in the changes since the prompt', async ($, on) => {
    const w = world(on)
    tools(on, w)
    await start($)
    await $.prompt.submit({ text: 'drop the users module', wait: false } as never)
    await w.clock.advance(100)
    w.files.delete('server/db/users.js')
    await $.tool.call({ tool: 'Bash', command: 'rm server/db/users.js' } as never)
    await w.clock.advance(10_000)
    const cards = w.get('cards') ?? []
    expect(cards.map(c => c.files)).toEqual([['server/db/users.js']])
    expect(cards[0]!.diff?.includes('-async function findUserByEmail(email) {')).toBe(true)
    expect(w.get('changes')?.files.map(f => [f.path, f.isDeleted])).toEqual([['server/db/users.js', true]])
  })

  test('a session in a subfolder of the repository sees shell changes there', async ($, on) => {
    const w = world(on)
    w.root = `${ROOT}/server`
    tools(on, w)
    await start($)
    w.files.set('server/app.js', w.files.get('server/app.js')! + '\nfunction health(req, res) {\n  res.json({ ok: true })\n}\n')
    await $.tool.call({ tool: 'Bash', command: 'python3 fix.py' } as never)
    await w.clock.advance(10_000)
    const cards = w.get('cards') ?? []
    expect(cards.map(c => c.files)).toEqual([['app.js']])
    expect(cards[0]!.diff?.includes('+function health(req, res) {')).toBe(true)
    expect(cards[0]!.diff?.includes('-const express')).toBe(false)
  })

  test('after the agent commits, a later shell change shows against the new commit', async ($, on) => {
    const w = world(on)
    tools(on, w)
    await start($)
    w.files.set('server/app.js', w.files.get('server/app.js')! + '\nfunction health(req, res) {\n  res.json({ ok: true })\n}\n')
    await $.tool.call({ tool: 'Bash', command: 'python3 fix.py' } as never)
    await w.clock.advance(10_000)
    w.commit()
    await $.tool.call({ tool: 'Bash', command: 'git commit -am "health"' } as never)
    await w.clock.advance(10_000)
    await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
    await w.clock.advance(10_000)
    w.files.set('server/app.js', w.files.get('server/app.js')! + '\nfunction ready(req, res) {\n  res.json({ ready: true })\n}\n')
    await $.tool.call({ tool: 'Bash', command: 'python3 fix2.py' } as never)
    await w.clock.advance(10_000)
    const cards = w.get('cards') ?? []
    expect(cards.length).toBe(2)
    expect(cards[0]!.diff?.includes('+function ready(req, res) {')).toBe(true)
    expect(cards[0]!.diff?.includes('+function health(req, res) {')).toBe(false)
  })

  test("the end of a turn waits for a scan still running, so the turn's changes are one step", async ($, on) => {
    const w = world(on)
    tools(on, w)
    await start($)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    w.files.set('server/app.js', w.files.get('server/app.js')! + '\nfunction health(req, res) {\n  res.json({ ok: true })\n}\n')
    let release = () => undefined as void
    const held = new Promise<void>(resolve => { release = resolve })
    w.gitGate = args => (args[0] === 'status' ? held : undefined)
    await $.tool.call({ tool: 'Bash', command: 'python3 fix.py' } as never)
    await w.clock.advance(1)
    await $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 't1' } as never)
    await w.clock.advance(1)
    w.gitGate = () => undefined
    release()
    await w.clock.advance(10_000)
    const cards = w.get('cards') ?? []
    expect(cards.map(c => [...c.files].sort())).toEqual([['server/app.js', 'server/auth/tokens.js']])
  })

  test("the person's own edits between turns are theirs, not the agent's", async ($, on) => {
    const w = world(on)
    tools(on, w)
    await start($)
    // Between turns, the person changes a file in their editor, then asks for something.
    w.files.set('server/db/users.js', w.files.get('server/db/users.js')! + '\nfunction countUsers() {\n  return 0\n}\n')
    await $.prompt.submit({ text: 'run the tests', wait: false } as never)
    await w.clock.advance(100)
    await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
    await $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 't1' } as never)
    await w.clock.advance(10_000)
    expect(w.get('cards') ?? []).toEqual([])
    // The agent's next change to that file shows against the person's version.
    w.files.set('server/db/users.js', w.files.get('server/db/users.js')!.replace('return 0', 'return db.count()'))
    await $.tool.call({ tool: 'Bash', command: 'sed -i ...' } as never)
    await w.clock.advance(10_000)
    const diff = (w.get('cards') ?? [])[0]?.diff ?? ''
    expect(diff.includes('+  return db.count()')).toBe(true)
    expect(diff.includes('+function countUsers() {')).toBe(false)
  })
})

describe('the end of a turn', () => {
  const summaryReply = (prompt: string) => prompt.includes('finished a turn')
    ? JSON.stringify({ title: 'Token refresh', changes: 'Tokens can now be refreshed, and sessions get their own table.', decisions: ['Sessions are kept in memory, so they are lost on restart.'] })
    : JSON.stringify({ worth_explaining: true, title: 'Step', summary: 'A step.', steps: [] })

  test('a turn of several steps ends with a summary of what the request did not say', async ($, on) => {
    const w = world(on, summaryReply)
    tools(on, w)
    await start($)
    await $.prompt.submit({ text: 'add token refresh', wait: false } as never)
    await w.clock.advance(100)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    await $.tool.call({ tool: 'Edit', ...editTables() } as never)
    await w.clock.advance(10_000)
    await $.turn.complete({ answer: 'Added refreshToken.', durationMs: 1000, isAborted: false, turnId: 't1' } as never)
    await w.clock.advance(1000)
    const card = (w.get('cards') ?? [])[0]!
    expect(card.source).toBe('turn')
    expect(card.title).toBe('Token refresh')
    expect(card.summary).toContain('**Decided along the way:**\n- Sessions are kept in memory')
    expect([...card.files].sort()).toEqual(['server/auth/tokens.js', 'server/db/index.js'])
    const asked = w.prompts.find(p => p.prompt.includes('finished a turn'))!.prompt
    // What was asked is given as known, never to be explained back; the steps' explanations come along.
    expect(asked).toContain('add token refresh')
    expect(asked).toContain('never explain it back to them')
    expect(asked).toContain('Added refreshToken.')
    expect(asked).toContain('- Step: A step.')
    // The turn's explanations sit under its summary, in the feed and in history.
    const cards = w.get('cards') ?? []
    expect(cards.filter(c => c.source === 'auto').every(c => c.turn === card.turn)).toBe(true)
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    expect(await ui.find({ text: /Token refresh · turn summary/ })).toBeDefined()
    const group = await ui.find({ key: `feed:turn:${card.id}` })
    expect(group).toBeDefined()
    for (const c of cards.filter(c => c.source === 'auto')) expect(JSON.stringify(group)).toContain(`feed:card:${c.id}`)
    await ui.press({ key: 'tab:history' })
    expect(await ui.find({ key: `history:turn:${card.id}` })).toBeDefined()
    await ui.unmount()
    // The turn continuing without a new prompt and no new step: nothing more to summarise.
    await $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 't2' } as never)
    await w.clock.advance(1000)
    expect(w.prompts.filter(p => p.prompt.includes('finished a turn')).length).toBe(1)
  })

  test('two turns ending together write one summary of their steps, not two', async ($, on) => {
    const w = world(on, summaryReply)
    tools(on, w)
    await start($)
    await $.prompt.submit({ text: 'add token refresh', wait: false } as never)
    await w.clock.advance(100)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    await $.tool.call({ tool: 'Edit', ...editTables() } as never)
    await w.clock.advance(10_000)
    await Promise.all([
      $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 't1' } as never),
      $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 't2' } as never),
    ])
    await w.clock.advance(1000)
    expect(w.prompts.filter(p => p.prompt.includes('finished a turn')).length).toBe(1)
    expect((w.get('cards') ?? []).filter(c => c.source === 'turn').length).toBe(1)
  })

  test('a turn the person did not start is summarised whole, saying how it began', async ($, on) => {
    const w = world(on, summaryReply)
    tools(on, w)
    await start($)
    await $.prompt.submit({ text: '<task-notification>build finished</task-notification>', origin: { kind: 'task-notification' }, wait: false } as never)
    await w.clock.advance(100)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    await $.tool.call({ tool: 'Edit', ...editTables() } as never)
    await w.clock.advance(10_000)
    await $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 't1' } as never)
    await w.clock.advance(1000)
    const asked = w.prompts.find(p => p.prompt.includes('finished a turn'))!.prompt
    expect(asked).toContain('it began from a background task finishing')
    expect(asked).not.toContain('build finished')
    expect(asked).not.toContain('never explain it back')
    expect((w.get('cards') ?? [])[0]!.source).toBe('turn')
  })

  test('a turn of one step gets only the choices the agent made, and no card when it made none', async ($, on) => {
    let decisions = ['Sessions are kept in memory, so they are lost on restart.']
    const w = world(on, prompt => prompt.includes('finished a turn')
      ? JSON.stringify({ title: 'Token refresh', changes: 'Repeats the explanation.', decisions })
      : JSON.stringify({ worth_explaining: true, title: 'Step', summary: 'A step.', steps: [] }))
    tools(on, w)
    await start($)
    for (const text of ['add token refresh', 'and a sessions table']) {
      await $.prompt.submit({ text, wait: false } as never)
      await w.clock.advance(100)
      await $.tool.call({ tool: 'Edit', ...(text === 'add token refresh' ? editTokens() : editTables()) } as never)
      await w.clock.advance(10_000)
      await $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: text } as never)
      await w.clock.advance(1000)
      decisions = []
    }
    const asked = w.prompts.filter(p => p.prompt.includes('finished a turn'))
    expect(asked.length).toBe(2)
    expect(asked[0]!.prompt).toContain('the turn was one step')
    const summaries = (w.get('cards') ?? []).filter(c => c.source === 'turn')
    // The step's explanation says what changed: the summary holds only the decision.
    expect(summaries.map(c => c.summary)).toEqual(['**Decided along the way:**\n- Sessions are kept in memory, so they are lost on restart.'])
  })

  for (const [name, settings, steps] of [['a turn with the summary turned off', { style: 'written', turnSummary: false }, 2]] as const) {
    test(`${name} gets no summary`, async ($, on) => {
      const w = world(on, summaryReply, { settings })
      tools(on, w)
      await start($)
      await $.prompt.submit({ text: 'add token refresh', wait: false } as never)
      await w.clock.advance(100)
      await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
      await w.clock.advance(10_000)
      if (steps === 2) {
        await $.tool.call({ tool: 'Edit', ...editTables() } as never)
        await w.clock.advance(10_000)
      }
      await $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 't1' } as never)
      await w.clock.advance(1000)
      expect(w.prompts.some(p => p.prompt.includes('finished a turn'))).toBe(false)
      expect((w.get('cards') ?? []).some(c => c.source === 'turn')).toBe(false)
      // The finished turn still groups, under a line naming its request.
      const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
      expect(await ui.find({ text: /“add token refresh”/ })).toBeDefined()
      expect(await ui.find({ text: new RegExp(`${steps} explanations?`) })).toBeDefined()
      await ui.unmount()
    })
  }
})

describe('changes since the last prompt', () => {
  test('the strip over the tabs shows each file changed since the prompt, net, and opens its diff', async ($, on) => {
    const w = world(on)
    tools(on, w)
    await start($)
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    expect(await ui.find({ text: /Files changed after your next prompt show here/ })).toBeDefined()
    await $.prompt.submit({ text: 'add token refresh and a health check', wait: false } as never)
    await w.clock.advance(100)
    expect(await ui.find({ text: /No files changed yet/ })).toBeDefined()
    // One file by the edit tool, one by a shell command, one created and then removed again.
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    w.files.set('server/app.js', w.files.get('server/app.js')! + '\nfunction health(req, res) {\n  res.json({ ok: true })\n}\n')
    w.files.set('server/scratch.js', 'const x = 1\n')
    await $.tool.call({ tool: 'Bash', command: 'python3 edit.py' } as never)
    w.files.delete('server/scratch.js')
    await $.tool.call({ tool: 'Bash', command: 'rm server/scratch.js' } as never)
    await w.clock.advance(100)
    const files = w.get('changes')?.files ?? []
    expect(files.map(f => f.path).sort()).toEqual(['server/app.js', 'server/auth/tokens.js'])
    expect(files.find(f => f.path === 'server/auth/tokens.js')?.added).toBe(7)
    expect(await ui.find({ text: /Since your last prompt/ })).toBeDefined()
    expect(await ui.find({ text: /2 files/ })).toBeDefined()
    expect(await ui.find({ text: /lines 18-24/ })).toBeDefined()
    await ui.press({ key: 'strip:1:server/auth/tokens.js' }).catch(() => ui.press({ key: 'strip:0:server/auth/tokens.js' }))
    expect(w.get('tab')).toBe('code')
    expect(w.get('viewer')?.path).toBe('server/auth/tokens.js')
    expect(w.get('viewer')?.diff?.includes('+function refreshToken(token) {')).toBe(true)
    // The next prompt starts over.
    await $.prompt.submit({ text: 'thanks', wait: false } as never)
    await w.clock.advance(100)
    expect(w.get('changes')?.files).toEqual([])
    await ui.unmount()
  })
})

describe('navigation', () => {
  test('tabs are independent; the Code tab alone steps back between code locations', async ($, on) => {
    const w = world(on, () => JSON.stringify({
      worth_explaining: true,
      title: 'Token refresh',
      summary: 'Adds refreshToken.',
      steps: [{ say: 'The new helper.', path: 'server/auth/tokens.js', line: 18, end_line: 22 }],
    }))
    tools(on, w)
    await start($)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    const card = (w.get('cards') ?? [])[0]!
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    expect(await ui.find({ key: 'nav:back' })).toBe(undefined)
    await ui.press({ key: `feed:step:${card.id}:0:open` })
    expect(w.get('tab')).toBe('code')
    expect(w.get('viewer')?.line).toBe(18)
    expect(await ui.find({ key: 'code:prev' })).toBe(undefined)
    // Follow a call to another place, then step back within the Code tab.
    await ui.press({ key: 'code:callee:0' })
    expect(w.get('viewer')?.line === 18).toBe(false)
    await ui.press({ key: 'code:prev' })
    expect(w.get('tab')).toBe('code')
    expect(w.get('viewer')?.line).toBe(18)
    // Switching tabs keeps each tab as it was.
    await ui.press({ key: 'tab:feed' })
    expect(w.get('expanded')).toBe(card.id)
    expect(await ui.find({ text: /Adds refreshToken/ })).toBeDefined()
    await ui.press({ key: 'tab:code' })
    expect(w.get('viewer')?.line).toBe(18)
    expect(await ui.find({ key: 'nav:back' })).toBe(undefined)
    await ui.unmount()
  })

  test('scrolling stops once the end of the file is on screen', async ($, on) => {
    const w = world(on)
    tools(on, w)
    await start($)
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    await $.command.run({ command: 'inloop-explain', args: 'server/auth/tokens.js:6' } as never)
    await ui.press({ key: 'tab:code' })
    for (let i = 0; i < 20; i++) await ui.press({ key: 'code:down' })
    const lines = DEMO_HEAD['server/auth/tokens.js']!.split('\n').length
    // The 19-line file fits in the window: nothing to scroll past.
    expect(lines < 24).toBe(true)
    expect(w.get('viewer')!.top).toBe(1)
    await ui.unmount()
  })
})

describe('what is asked about', () => {
  test('a session in the home folder explains nothing there, and says why', async ($, on) => {
    const w = world(on)
    w.root = '/virtual/home'
    tools(on, w)
    await start($)
    await $.command.run({ command: 'inloop', args: 'explain the repo' } as never)
    await w.clock.advance(10)
    const answer = (w.get('convo') ?? []).at(-1)
    expect(answer?.text.includes('not a project')).toBe(true)
    expect(w.prompts.length).toBe(0)
  })

  test('outside git, the commit commands say so instead of finding no commit', async ($, on) => {
    const w = world(on)
    w.isGit = false
    tools(on, w)
    await start($)
    const found = await $.command.run({ command: 'inloop-commit', args: 'fix login' } as never) as { text: string }
    expect(found.text).toBe('This project is not a git repository.')
    const compared = await $.command.run({ command: 'inloop-compare', args: 'HEAD~1 HEAD' } as never) as { text: string }
    expect(compared.text).toBe('This project is not a git repository.')
  })

  test('an answer cut off mid-JSON is never shown raw; one cut off after its answer keeps the answer', async ($, on) => {
    let reply = '{"answer": "The password is checked by'
    const w = world(on, () => reply)
    tools(on, w)
    await start($)
    await $.command.run({ command: 'inloop', args: 'how is the password checked?' } as never)
    await w.clock.advance(10)
    const said = (w.get('convo') ?? []).filter(t => t.role === 'inloop').map(t => t.text)
    expect(said).toEqual(['Could not answer: the reply was cut off'])
    reply = '```json\n{"answer": "By `verifyPassword`, which compares the hash.", "refs": [{"path": "server/auth/pass'
    await $.command.run({ command: 'inloop', args: 'how is the password hash compared?' } as never)
    await w.clock.advance(10)
    expect((w.get('convo') ?? []).at(-1)?.text).toBe('By `verifyPassword`, which compares the hash.')
  })

  test('a question about the whole repo starts from its big picture', async ($, on) => {
    const w = world(on, () => JSON.stringify({ answer: 'It is a demo app for learning sign-in.', refs: [], steps: [], flow: null, scope: '' }))
    tools(on, w)
    await start($)
    await $.command.run({ command: 'inloop', args: 'explain this repo' } as never)
    await w.clock.advance(10)
    const prompt = w.prompts[0]?.prompt ?? ''
    expect(prompt.includes("The project's big picture")).toBe(true)
    expect(prompt.includes('"name": "demo-app"')).toBe(true)
    expect(prompt.includes('server/ (')).toBe(true)
    expect(w.prompts[0]?.system.includes('what it is FOR')).toBe(true)
    // A narrow question does not carry it.
    await $.command.run({ command: 'inloop', args: 'how is the password checked?' } as never)
    await w.clock.advance(10)
    expect(w.prompts.at(-1)?.prompt.includes("The project's big picture")).toBe(false)
  })
})

describe('the reader agent', () => {
  test('a question asks the read-only reader first, with the question, the context and the answer shape', async ($, on) => {
    const w = world(on, () => JSON.stringify({ answer: 'From the lookups.', refs: [], steps: [], flow: null, scope: '' }))
    tools(on, w)
    await start($)
    expect(w.registeredAgents.map(a => [a.name, a.permissionMode, a.tools, a.background])).toEqual([['reader', 'dontAsk', ['Read', 'Grep', 'Glob', 'Bash'], true]])
    await $.command.run({ command: 'inloop', args: 'how is the password checked?' } as never)
    await w.clock.advance(10)
    expect(w.spawned.length).toBe(1)
    const job = w.spawned[0]!
    expect(job.model).toBe('sonnet')
    expect(job.prompt.includes("Developer's question: how is the password checked?")).toBe(true)
    expect(job.prompt.includes('function verifyPassword')).toBe(true)
    expect(job.prompt.includes('"answer": "markdown')).toBe(true)
    // (In the test kit only Claude Code itself can start an agent, so the question falls back and is still answered.)
    expect((w.get('convo') ?? []).at(-1)?.text).toBe('From the lookups.')
  })

  test('with the reader turned off in Settings, no agent is started', async ($, on) => {
    const w = world(on, () => JSON.stringify({ answer: 'From the lookups.', refs: [], steps: [], flow: null, scope: '' }), { settings: { style: 'written', useReader: false } })
    tools(on, w)
    await start($)
    await $.command.run({ command: 'inloop', args: 'how is the password checked?' } as never)
    await w.clock.advance(10)
    expect(w.spawned.length).toBe(0)
    expect((w.get('convo') ?? []).at(-1)?.text).toBe('From the lookups.')
  })

  test("when the reader can't run, questions fall back to inloop's own lookups", async ($, on) => {
    const w = world(on, () => JSON.stringify({ answer: 'From the lookups.', refs: [], steps: [], flow: null, scope: '' }))
    w.isReaderOn = false
    tools(on, w)
    await start($)
    await $.command.run({ command: 'inloop', args: 'how is the password checked?' } as never)
    await w.clock.advance(10)
    expect((w.get('convo') ?? []).at(-1)?.text).toBe('From the lookups.')
    expect(w.prompts.length).toBe(1)
  })
})

describe('narrow dock', () => {
  test('short tab labels and no paths in the flow tree at 30 columns', async ($, on) => {
    const w = world(on, () => JSON.stringify({ answer: 'ok', refs: [], flow: { entry: 'login' }, scope: '' }))
    tools(on, w)
    await start($)
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: { ...PANE_PROPS, bodyColumns: 30 } as never })
    expect(await ui.find({ text: /^Hist$/ })).toBeDefined()
    expect(await ui.find({ text: /^History$/ })).toBe(undefined)
    await ui.press({ key: 'tab:flow' })
    await ui.input({ key: 'flowq', text: 'what does login do' })
    await w.clock.advance(100)
    expect(await ui.find({ key: 'node:n0' })).toBeDefined()
    expect(await ui.find({ text: /server\/auth\/controller\.js:5/ })).toBe(undefined)
    await ui.unmount()
  })
})

/** Lets the confirmation a command speaks finish, and forgets it. */
/** Lets a confirmation that is being said (or still rendering) finish, then forgets it. */
async function quiet(w: World): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await w.clock.advance(1)
    w.finishSpeech()
  }
  await w.clock.advance(1)
  w.said.length = 0
}

describe('styles', () => {
  const STEPPED = () => JSON.stringify({
    worth_explaining: true,
    title: 'Token refresh',
    summary: 'The agent added `refreshToken`.',
    steps: [
      { say: 'refreshToken checks the old token first.', path: 'server/auth/tokens.js', line: 18, end_line: 22 },
      { say: 'It is exported next to createToken.', path: 'server/auth/tokens.js', line: 24, end_line: 24 },
      { say: 'This one points nowhere.', path: 'missing.js', line: 1 },
    ],
  })

  test('written: the new explanation opens by itself with each part and its code', async ($, on) => {
    const w = world(on, STEPPED)
    tools(on, w)
    await start($)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    const card = (w.get('cards') ?? [])[0]!
    expect(card.steps?.length).toBe(2)
    expect(card.steps?.[0]?.code?.startsWith('function refreshToken(token) {')).toBe(true)
    expect(card.steps?.[0]?.codeStart).toBe(18)
    expect(card.steps?.[1]?.code).toBe('module.exports = { createToken, verifyToken, refreshToken }')
    expect(w.get('expanded')).toBe(card.id)
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    expect(await ui.find({ text: /refreshToken checks the old token first/ })).toBeDefined()
    expect(await ui.find({ text: /const claims = verifyToken\(token\)/ })).toBeDefined()
    // Nothing is read aloud in the written style.
    expect(w.said.length).toBe(0)
    await ui.unmount()
  })

  test('spoken: each part is read with its code on screen, with the best voice and no paths', { timeoutMs: 20_000 }, async ($, on) => {
    const w = world(on, STEPPED)
    tools(on, w)
    await start($)
    await $.command.run({ command: 'inloop-style', args: 'spoken' } as never)
    await quiet(w)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    // The explanation itself first (no title read out), then each part with its code in the pinned box.
    expect(w.get('narration')?.index).toBe(0)
    expect(await ui.find({ text: /part 1 of 3/ })).toBeDefined()
    w.finishSpeech()
    await w.clock.advance(1)
    expect(w.get('narration')?.index).toBe(1)
    expect(await ui.find({ text: /part 2 of 3/ })).toBeDefined()
    expect(await ui.find({ text: /const claims = verifyToken\(token\)/ })).toBeDefined()
    w.finishSpeech()
    await w.clock.advance(1)
    expect(w.get('narration')?.index).toBe(2)
    w.finishSpeech()
    await w.clock.advance(1)
    // Finished: kept loaded, back at part 1, with replay and close.
    expect(w.get('narration')?.isEnded).toBe(true)
    expect(w.get('narration')?.index).toBe(0)
    expect(await ui.find({ text: /finished · back at part 1 of 3/ })).toBeDefined()
    expect(w.said.map(x => x.text)).toEqual(['The agent added refreshToken.', 'refreshToken checks the old token first.', 'It is exported next to createToken.'])
    expect(w.said.every(x => !x.isCut)).toBe(true)
    expect(w.said.at(-1)?.voice).toBe('Zoe (Premium)')
    await ui.unmount()
  })

  test('spoken controls cut speech off: next skips a part, pause and resume repeat it, stop ends', { timeoutMs: 20_000 }, async ($, on) => {
    const w = world(on, STEPPED)
    tools(on, w)
    await start($)
    await $.command.run({ command: 'inloop-style', args: 'spoken' } as never)
    await quiet(w)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    await ui.press({ key: 'say:next' })
    await w.clock.advance(1)
    expect(w.get('narration')?.index).toBe(1)
    await ui.press({ key: 'say:pause' })
    await w.clock.advance(1)
    expect(w.get('narration')?.isPaused).toBe(true)
    expect(w.said.length).toBe(2)
    await ui.press({ key: 'say:resume' })
    await w.clock.advance(1)
    expect(w.get('narration')?.index).toBe(1)
    await ui.press({ key: 'say:stop' })
    await w.clock.advance(1)
    // Stopped: kept at part 1 to replay or close, nothing more said.
    expect(w.get('narration')?.isEnded).toBe(true)
    expect(w.get('narration')?.index).toBe(0)
    expect(w.said.map(x => x.text)).toEqual(['The agent added refreshToken.', 'refreshToken checks the old token first.', 'refreshToken checks the old token first.'])
    expect(w.said.every(x => x.isCut)).toBe(true)
    await ui.press({ key: 'say:close' })
    await w.clock.advance(1)
    expect(w.get('narration')).toBe(null)
    await ui.unmount()
  })

  test('switching style mid-explanation: written silences at once, spoken picks up with the next change', { timeoutMs: 20_000 }, async ($, on) => {
    const w = world(on, STEPPED)
    tools(on, w)
    await start($)
    await $.command.run({ command: 'inloop-style', args: 'spoken' } as never)
    await w.clock.advance(1)
    // Written while the confirmation is still being said: it is cut off.
    await $.command.run({ command: 'inloop-style', args: 'written' } as never)
    await w.clock.advance(1)
    expect(w.said.length).toBe(1)
    expect(w.said[0]!.isCut).toBe(true)
    await $.command.run({ command: 'inloop-style', args: 'spoken' } as never)
    await quiet(w)
    const before = w.said.length
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    expect(w.get('narration')?.index).toBe(0)
    // Written mid-explanation: the part being read stops, nothing more is said, and the card stays open to read.
    await $.command.run({ command: 'inloop-style', args: 'written' } as never)
    await w.clock.advance(1)
    expect(w.get('narration')).toBe(null)
    expect(w.said.length).toBe(before + 1)
    expect(w.said.at(-1)!.isCut).toBe(true)
    const card = (w.get('cards') ?? [])[0]!
    expect(w.get('expanded')).toBe(card.id)
    // A change while written is shown, not said.
    w.files.set('server/app.js', w.files.get('server/app.js')! + '\nfunction health(req, res) {\n  res.json({ ok: true })\n}\n')
    await $.tool.call({ tool: 'Bash', command: 'python3 edit.py' } as never)
    await w.clock.advance(10_000)
    expect((w.get('cards') ?? []).length).toBe(2)
    expect(w.said.length).toBe(before + 1)
    expect(w.get('expanded')).toBe((w.get('cards') ?? [])[0]!.id)
    // Back to spoken: the next change is read aloud from its start.
    await $.command.run({ command: 'inloop-style', args: 'spoken' } as never)
    await quiet(w)
    const spokenAt = w.said.length
    w.files.set('server/db/users.js', w.files.get('server/db/users.js')! + '\nfunction countUsers() {\n  return 0\n}\n')
    await $.tool.call({ tool: 'Bash', command: 'python3 edit2.py' } as never)
    await w.clock.advance(10_000)
    expect(w.get('narration')?.index).toBe(0)
    expect(w.said.length).toBe(spokenAt + 1)
    expect(w.said.at(-1)!.text).toBe('The agent added refreshToken.')
    await $.command.run({ command: 'inloop-style', args: 'written' } as never)
    await w.clock.advance(1)
    expect(w.get('narration')).toBe(null)
  })

  test('spoken with Kokoro set up: parts are rendered by Kokoro and played as clips that stop at once', { timeoutMs: 20_000 }, async ($, on) => {
    const w = world(on, STEPPED)
    w.kokoro = true
    tools(on, w)
    await start($)
    await $.command.run({ command: 'inloop-style', args: 'spoken' } as never)
    await quiet(w)
    const before = w.said.length
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    expect(w.get('narration')?.index).toBe(0)
    const playing = w.said.slice(before)
    expect(playing.map(x => x.text)).toEqual(['The agent added refreshToken.'])
    expect(playing[0]?.voice).toBe('kokoro:af_heart')
    w.finishSpeech()
    await w.clock.advance(1)
    expect(w.get('narration')?.index).toBe(1)
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    await ui.press({ key: 'say:stop' })
    await w.clock.advance(1)
    expect(w.get('narration')?.isEnded).toBe(true)
    expect(w.said.at(-1)?.isCut).toBe(true)
    // Replay: from part 1, the clips already made, no second render.
    const renders = w.clips.size
    await ui.press({ key: 'say:replay' })
    await w.clock.advance(1)
    expect(w.get('narration')?.isEnded).not.toBe(true)
    expect(w.get('narration')?.index).toBe(0)
    expect(w.said.at(-1)?.text).toBe('The agent added refreshToken.')
    expect(w.said.at(-1)?.voice).toBe('kokoro:af_heart')
    expect(w.clips.size).toBe(renders)
    // Close mid-replay: stops at once and unloads.
    await ui.press({ key: 'say:close' })
    await w.clock.advance(1)
    expect(w.get('narration')).toBe(null)
    expect(w.said.at(-1)?.isCut).toBe(true)
    await ui.unmount()
  })

  test('a finished explanation stays loaded until another one plays', { timeoutMs: 20_000 }, async ($, on) => {
    const w = world(on, STEPPED)
    tools(on, w)
    await start($)
    await $.command.run({ command: 'inloop-style', args: 'spoken' } as never)
    await quiet(w)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    for (let i = 0; i < 3; i++) {
      w.finishSpeech()
      await w.clock.advance(1)
    }
    const first = w.get('narration')
    expect(first?.isEnded).toBe(true)
    // A new explanation replaces it.
    w.files.set('server/app.js', w.files.get('server/app.js')! + '\nfunction health(req, res) {\n  res.json({ ok: true })\n}\n')
    await $.tool.call({ tool: 'Bash', command: 'python3 fix.py' } as never)
    await w.clock.advance(10_000)
    expect(w.get('narration')?.cardId).not.toBe(first?.cardId)
    expect(w.get('narration')?.isEnded).not.toBe(true)
    await $.command.run({ command: 'inloop-style', args: 'written' } as never)
    await w.clock.advance(1)
    expect(w.get('narration')).toBe(null)
  })

  test('out of the box: spoken style, and the natural voice downloads in the background once', { timeoutMs: 20_000 }, async ($, on) => {
    const w = world(on, STEPPED)
    w.stored.delete('settings')
    w.kokoro = true
    w.isKokoroInstalled = false
    w.isSetupHeld = true
    tools(on, w)
    await start($)
    await w.clock.advance(1)
    expect(w.get('settings')?.style).toBe('spoken')
    expect(w.setupRuns).toBe(1)
    expect(w.get('status')?.isVoiceSettingUp).toBe(true)
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    expect(await ui.find({ text: /downloading the natural voice/ })).toBeDefined()
    // The spinner turns while it downloads.
    const frame = w.get('frame') ?? 0
    await w.clock.advance(600)
    expect((w.get('frame') ?? 0) - frame >= 4).toBe(true)
    expect(await ui.find({ text: /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] downloading the natural voice/ })).toBeDefined()
    // Asking for it meanwhile joins the download under way.
    await $.command.run({ command: 'inloop-voice', args: 'setup' } as never)
    await w.clock.advance(1)
    expect(w.setupRuns).toBe(1)
    // Until it is ready, a change is read by the Mac voice.
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    expect(w.said.at(-1)?.voice).toBe('Zoe (Premium)')
    await ui.press({ key: 'say:stop' })
    w.releaseSetup()
    await w.clock.advance(1)
    expect(w.get('status')?.isVoiceSettingUp).toBe(false)
    expect(w.toasts.some(t => /natural voice \(Kokoro\) is ready/.test(t))).toBe(true)
    // Idle again: the spinner stops, so nothing redraws for nothing.
    const still = w.get('frame')
    await w.clock.advance(2000)
    expect(w.get('frame')).toBe(still)
    expect(await ui.find({ text: /downloading the natural voice/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a person who turned the automatic download off is never downloaded for', async ($, on) => {
    const w = world(on, undefined, { settings: { autoVoiceSetup: false } })
    w.kokoro = true
    w.isKokoroInstalled = false
    tools(on, w)
    await start($)
    await w.clock.advance(1)
    expect(w.setupRuns).toBe(0)
  })

  test('without uv: at start, uv is fetched into the cache, checked, then the voice', { timeoutMs: 20_000 }, async ($, on) => {
    const w = world(on, STEPPED)
    w.stored.delete('settings')
    w.isKokoroInstalled = false
    w.isOnline = true
    tools(on, w)
    await start($)
    await w.clock.advance(1)
    expect(w.uvFetches.length).toBe(1)
    expect(w.uvFetches[0]).toBe('https://github.com/astral-sh/uv/releases/download/0.12.23/uv-aarch64-apple-darwin.tar.gz')
    expect(w.isUvCached).toBe(true)
    expect(w.setupRuns).toBe(1)
    // Its packages and any Python it fetches stay in inloop's cache.
    expect(w.setupEnv).toEqual({ UV_CACHE_DIR: '/virtual/home/.cache/inloop/uv', UV_PYTHON_INSTALL_DIR: '/virtual/home/.cache/inloop/python' })
    expect(w.toasts.some(t => /natural voice \(Kokoro\) is ready/.test(t))).toBe(true)
    // The cached uv speaks from now on.
    await quiet(w)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    expect(w.said.at(-1)?.voice).toBe('kokoro:af_heart')
    await $.command.run({ command: 'inloop-style', args: 'written' } as never)
    await w.clock.advance(1)
  })

  test('a uv download that does not match its published checksum is not unpacked or used', async ($, on) => {
    const w = world(on)
    w.isKokoroInstalled = false
    w.isOnline = true
    w.uvSum = '0'.repeat(64)
    tools(on, w)
    await start($)
    await w.clock.advance(1)
    expect(w.uvFetches.length).toBe(1)
    expect(w.isUvCached).toBe(false)
    expect(w.setupRuns).toBe(0)
    // Asked again, it tries again and says why it could not.
    expect((await $.command.run({ command: 'inloop-voice', args: 'setup' } as never)).text).toMatch(/fetching uv/)
    await w.clock.advance(1)
    expect(w.uvFetches.length).toBe(2)
    expect(w.isUvCached).toBe(false)
    expect(w.logs.some(t => /did not match its published checksum/.test(t))).toBe(true)
  })

  test('with the automatic download off, uv is not fetched', async ($, on) => {
    const off = world(on, undefined, { settings: { autoVoiceSetup: false } })
    off.isOnline = true
    tools(on, off)
    await start($)
    await off.clock.advance(1)
    expect(off.uvFetches.length).toBe(0)
    expect(off.isUvCached).toBe(false)
  })

  test('"reload voices" redraws the voice controls with what it found', async ($, on) => {
    const w = world(on, undefined, { settings: { style: 'written', autoVoiceSetup: false } })
    w.kokoro = true
    w.isKokoroInstalled = false
    tools(on, w)
    await start($)
    await w.clock.advance(1)
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    await ui.press({ key: 'tab:settings' })
    expect(await ui.find({ key: 'set:kokoro' })).toBeDefined()
    // Installed meanwhile (another session's /inloop-voice setup).
    w.isKokoroInstalled = true
    await ui.press({ key: 'set:reloadvoices' })
    await w.clock.advance(1)
    expect(await ui.find({ key: 'set:kokoro' })).toBe(undefined)
    await ui.unmount()
  })

  for (const [platform, players] of [['Linux', ['aplay', 'paplay']], ['Windows', ['powershell']]] as const) {
    test(`${platform}: Kokoro's clips play through the player the machine has`, { timeoutMs: 20_000 }, async ($, on) => {
      const w = world(on, STEPPED)
      w.kokoro = true
      w.hasSay = false
      w.players = [...players]
      tools(on, w)
      await start($)
      await $.command.run({ command: 'inloop-style', args: 'spoken' } as never)
      await quiet(w)
      await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
      await w.clock.advance(10_000)
      expect(w.said.map(x => x.voice)).toEqual(['kokoro:af_heart'])
      // The first player found wins: PipeWire, then PulseAudio, then ALSA.
      expect(w.playersUsed.at(-1)).toBe(platform === 'Linux' ? 'paplay' : 'powershell')
      w.finishSpeech()
      await w.clock.advance(1)
      expect(w.said.at(-1)?.text).toBe('refreshToken checks the old token first.')
      await $.command.run({ command: 'inloop-style', args: 'written' } as never)
      await w.clock.advance(1)
    })
  }

  test('with no audio player, nothing is downloaded and the platform voice speaks', { timeoutMs: 20_000 }, async ($, on) => {
    const w = world(on, STEPPED)
    w.stored.delete('settings')
    w.kokoro = true
    w.isKokoroInstalled = false
    w.hasSay = false
    w.players = []
    tools(on, w)
    await start($)
    await w.clock.advance(1)
    expect(w.setupRuns).toBe(0)
    await quiet(w)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    expect(w.spoken.includes('The agent added refreshToken.')).toBe(true)
    expect((await $.command.run({ command: 'inloop-voice', args: 'setup' } as never)).text).toMatch(/audio player/)
    await $.command.run({ command: 'inloop-style', args: 'written' } as never)
    await w.clock.advance(1)
  })

  test('a clip the player cannot play is said by the system voice, not skipped', { timeoutMs: 20_000 }, async ($, on) => {
    const w = world(on, STEPPED)
    w.kokoro = true
    w.isPlayerBroken = true
    tools(on, w)
    await start($)
    await $.command.run({ command: 'inloop-style', args: 'spoken' } as never)
    await quiet(w)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    expect(w.said.map(x => [x.text, x.voice])).toEqual([['The agent added refreshToken.', 'Zoe (Premium)']])
    await $.command.run({ command: 'inloop-style', args: 'written' } as never)
    await w.clock.advance(1)
  })

  test('while Kokoro is still rendering, the pane and status line say audio is being generated', { timeoutMs: 20_000 }, async ($, on) => {
    const w = world(on, STEPPED)
    w.kokoro = true
    tools(on, w)
    await start($)
    await $.command.run({ command: 'inloop-style', args: 'spoken' } as never)
    await quiet(w)
    w.isRenderHeld = true
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    expect(w.get('narration')?.isPreparing).toBe(true)
    expect(w.get('status')?.isPreparingAudio).toBe(true)
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    expect(await ui.find({ text: /generating audio/ })).toBeDefined()
    expect(w.said.length).toBe(0)
    w.releaseRender()
    await w.clock.advance(1)
    expect(w.get('narration')?.isPreparing).toBe(false)
    expect(w.get('status')?.isPreparingAudio).toBe(false)
    expect(w.said.map(x => x.text)).toEqual(['The agent added refreshToken.'])
    expect(await ui.find({ text: /generating audio/ })).toBeUndefined()
    await ui.press({ key: 'say:stop' })
    await w.clock.advance(1)
    await ui.unmount()
  })

  test("the coding agent is asked for brief replies only while inloop is active", async ($, on) => {
    const w = world(on)
    tools(on, w)
    await start($)
    const ids = async () => (await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as never)).sections.map(x => x.id)
    // Auto mode, pane open (in front or behind another panel): brief.
    expect(await ids()).toEqual(['intro', 'inloop:brief-replies'])
    w.pane = 'behind'
    expect(await ids()).toEqual(['intro', 'inloop:brief-replies'])
    // Pane closed: nobody sees inloop's explanations, so the agent explains as usual...
    w.pane = 'closed'
    expect(await ids()).toEqual(['intro'])
    // ...unless they are being read aloud.
    await $.command.run({ command: 'inloop-style', args: 'spoken' } as never)
    expect(await ids()).toEqual(['intro', 'inloop:brief-replies'])
    await $.command.run({ command: 'inloop-style', args: 'written' } as never)
    w.pane = 'shown'
    await $.command.run({ command: 'inloop-mode', args: 'paused' } as never)
    expect(await ids()).toEqual(['intro'])
    await $.command.run({ command: 'inloop-mode', args: 'auto' } as never)
    await $.command.run({ command: 'inloop-brief', args: 'off' } as never)
    expect(await ids()).toEqual(['intro'])
  })

  test('headless runs never shorten the coding agent', async ($, on) => {
    const w = world(on)
    tools(on, w)
    await $.session.start({ cwd: ROOT, surface: null, isInteractive: false } as never)
    const composed = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: ['print'] } as never)
    expect(composed.sections.map(x => x.id)).toEqual(['intro'])
    void w
  })

  test('headless runs explain changes but never read them aloud', { timeoutMs: 20_000 }, async ($, on) => {
    const w = world(on, STEPPED)
    tools(on, w)
    await $.session.start({ cwd: ROOT, surface: null, isInteractive: false } as never)
    await $.command.run({ command: 'inloop-style', args: 'spoken' } as never)
    await w.clock.advance(10_000)
    w.said.length = 0
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    expect((w.get('cards') ?? []).map(c => c.title)).toEqual(['Token refresh'])
    await w.clock.advance(10_000)
    expect(w.said).toEqual([])
    expect(w.get('narration') ?? null).toBe(null)
  })

  test('spoken, with the pane hidden: the part and its code show above the prompt', { timeoutMs: 20_000 }, async ($, on) => {
    const w = world(on, STEPPED)
    tools(on, w)
    await start($)
    await $.command.run({ command: 'inloop-style', args: 'spoken' } as never)
    await quiet(w)
    w.pane = 'behind'
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    const band = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100 } as never })
    expect(await band.find({ text: /1\/3/ })).toBeDefined()
    expect(await band.find({ text: /The agent added refreshToken/ })).toBeDefined()
    w.finishSpeech()
    await w.clock.advance(1)
    expect(await band.find({ text: /2\/3/ })).toBeDefined()
    expect(await band.find({ text: /refreshToken checks the old token first/ })).toBeDefined()
    expect(await band.find({ text: /const claims = verifyToken\(token\)/ })).toBeDefined()
    await band.press({ key: 'band:stop' })
    await w.clock.advance(1)
    expect(w.get('narration')?.isEnded).toBe(true)
    expect(await band.find({ text: /finished/ })).toBeDefined()
    await band.press({ key: 'band:close' })
    await w.clock.advance(1)
    expect(w.get('narration')).toBe(null)
    await band.unmount()
  })

  /** Changes in turn, each made by a script and explained on its own. */
  async function jobs($: { tool: { call: (e: never) => Promise<unknown> } }, w: World, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      w.files.set(`server/job${i}.js`, `function job${i}(input) {\n  const scaled = input * ${i + 2}\n  return scaled\n}\n\nmodule.exports = { job${i} }\n`)
      await $.tool.call({ tool: 'Bash', command: `node make-job.js ${i}` } as never)
      await w.clock.advance(10_000)
    }
  }

  test('away: explanations are written and queued, unread, with audio made for five at most', { timeoutMs: 60_000 }, async ($, on) => {
    const w = world(on, STEPPED)
    w.kokoro = true
    tools(on, w)
    await start($)
    await $.command.run({ command: 'inloop-style', args: 'spoken' } as never)
    await $.command.run({ command: 'inloop-mode', args: 'paused' } as never)
    await quiet(w)
    const away = await $.command.run({ command: 'inloop-away', args: '' } as never) as { text: string }
    expect(away.text).toContain('/inloop-play')
    // Away explains changes even from a paused mode.
    expect(w.get('settings').mode).toBe('auto')
    const renders = w.renders
    await jobs($, w, 7)
    expect(w.said.length).toBe(0)
    expect(w.get('narration')).toBe(null)
    expect(w.get('status').waiting).toBe(7)
    expect(w.get('status').voiced).toBe(5)
    expect(w.renders - renders).toBe(5)
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    expect(await ui.find({ key: 'away:back' })).toBeDefined()
    await ui.unmount()

    const back = await $.command.run({ command: 'inloop-play', args: '' } as never) as { text: string }
    expect(back.text).toContain('Reading 7 explanations')
    expect(back.text).toContain('paused again')
    expect(w.get('settings').mode).toBe('paused')
    await w.clock.advance(1)
    expect(w.get('narration')?.writtenAt).toBeDefined()
    expect(w.said.at(-1)?.voice).toBe('kokoro:af_heart')
    // The first one plays straight away: its audio was made ahead, no new render.
    expect(w.renders - renders).toBe(5)
    // Each one read frees a place, and the next waiting one's audio is made, one at a time.
    const parts = w.get('narration')!.steps.length
    for (let i = 0; i < parts; i++) {
      w.finishSpeech()
      await w.clock.advance(1)
    }
    expect(w.renders - renders).toBe(6)
    expect(w.get('status').waiting).toBe(5)
    for (let i = 0; i < parts * 6; i++) {
      w.finishSpeech()
      await w.clock.advance(1)
    }
    expect(w.renders - renders).toBe(7)
    expect(w.get('status').waiting).toBe(0)
    expect(w.get('narration')?.isEnded).toBe(true)
  })

  test('explanations arriving faster than they are read keep five audios made, the rest as text', { timeoutMs: 60_000 }, async ($, on) => {
    const w = world(on, STEPPED)
    w.kokoro = true
    tools(on, w)
    await start($)
    await $.command.run({ command: 'inloop-style', args: 'spoken' } as never)
    await quiet(w)
    const renders = w.renders
    // Nothing is finished being read while seven come in.
    await jobs($, w, 7)
    expect(w.get('narration')?.index).toBe(0)
    expect(w.get('status').waiting).toBe(6)
    expect(w.get('status').voiced).toBe(4)
    expect(w.renders - renders).toBe(5)
    for (let i = 0; i < 4 * 7 + 2; i++) {
      w.finishSpeech()
      await w.clock.advance(1)
    }
    // None was dropped: every one was read, each rendered once.
    expect(w.renders - renders).toBe(7)
    expect(w.get('status').waiting).toBe(0)
  })

  test('away: a voice test, or listening to one explanation and closing it, keeps what waits', { timeoutMs: 60_000 }, async ($, on) => {
    const w = world(on, STEPPED)
    w.kokoro = true
    tools(on, w)
    await start($)
    await $.command.run({ command: 'inloop-style', args: 'spoken' } as never)
    await quiet(w)
    await $.command.run({ command: 'inloop-away', args: '' } as never)
    await jobs($, w, 2)
    expect(w.get('status').waiting).toBe(2)
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    // Listening to one now reads it, even while away (so it no longer waits); closing it leaves the rest waiting.
    const card = w.get('cards')[1]!
    await ui.press({ key: `feed:card:${card.id}` })
    await ui.press({ key: `feed:say:${card.id}` })
    await w.clock.advance(1)
    expect(w.get('narration')?.cardId).toBe(card.id)
    await ui.press({ key: 'say:close' })
    await w.clock.advance(1)
    expect(w.get('narration')).toBe(null)
    expect(w.get('status').waiting).toBe(1)
    // A voice test is other audio: it plays, and what waits stays.
    await ui.press({ key: 'tab:settings' })
    await ui.press({ key: 'set:testvoice' })
    await w.clock.advance(1)
    w.finishSpeech()
    await w.clock.advance(1)
    expect(w.get('status').waiting).toBe(1)
    await ui.unmount()
    const back = await $.command.run({ command: 'inloop-play', args: '' } as never) as { text: string }
    expect(back.text).toContain('Reading 1 explanation,')
  })

  test('away survives /clear: what waits is still there to play', { timeoutMs: 60_000 }, async ($, on) => {
    const w = world(on, STEPPED)
    w.kokoro = true
    tools(on, w)
    on('session.end', () => ({ sessionId: 's1' }) as never)
    await start($)
    await $.command.run({ command: 'inloop-style', args: 'spoken' } as never)
    await quiet(w)
    await $.command.run({ command: 'inloop-away', args: '' } as never)
    await jobs($, w, 3)
    await $.session.end({ reason: 'clear' } as never)
    await w.clock.advance(1)
    expect(w.get('status').waiting).toBe(3)
    expect(w.get('status').voiced).toBe(3)
    expect(w.said.length).toBe(0)
    const back = await $.command.run({ command: 'inloop-play', args: '' } as never) as { text: string }
    expect(back.text).toContain('Reading 3 explanations')
  })

  test('away in written style: /inloop-play opens the oldest explanation written meanwhile', { timeoutMs: 60_000 }, async ($, on) => {
    const w = world(on, STEPPED)
    tools(on, w)
    await start($)
    await $.command.run({ command: 'inloop-style', args: 'written' } as never)
    await $.command.run({ command: 'inloop-away', args: '' } as never)
    await jobs($, w, 3)
    const cards = w.get('cards')
    const back = await $.command.run({ command: 'inloop-play', args: '' } as never) as { text: string }
    expect(back.text).toContain('3 explanations were written while you were away')
    expect(w.get('expanded')).toBe(cards[2]!.id)
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    expect(await ui.find({ key: 'away:back' })).toBe(undefined)
    await ui.unmount()
  })

})
