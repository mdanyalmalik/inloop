import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { DEMO_HEAD } from './fixtures'
import { ROOT, start, world, type World } from './harness'

type Edit = { file_path: string; old_string: string; new_string: string }

/** The bottom of tool.call: applies Edit and Write to the virtual files, as the tools would. */
function tools(on: On, w: World): void {
  on('tool.call', ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const rel = String(input.file_path).slice(ROOT.length + 1)
    if (String(e.tool) === 'Write') {
      w.files.set(rel, String(input.content))
      return { result: { type: 'create' }, text: `wrote ${rel}` } as never
    }
    if (String(e.tool) === 'Edit') {
      const held = w.files.get(rel) ?? ''
      w.files.set(rel, held.replace(String(input.old_string), String(input.new_string)))
      return { result: { filePath: rel }, text: `edited ${rel}` } as never
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
    expect(w.get('cards') ?? []).toEqual([])
    expect(w.prompts.length).toBe(0)
  })

  test('focus mode skips changes off the topic', async ($, on) => {
    const w = world(on)
    tools(on, w)
    await start($)
    await $.command.run({ command: 'inloop-focus', args: 'database queries' } as never)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    expect(w.get('cards') ?? []).toEqual([])
    expect(w.prompts.length).toBe(0)
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
    const convo = w.get('convo') ?? []
    expect(convo.at(-1)?.refs?.map(r => r.path)).toEqual(['server/auth/controller.js'])
    expect(w.get('ctx')?.scope).toBe('the login flow')
    // The answer opened the first reference.
    expect(w.get('viewer')?.path).toBe('server/auth/controller.js')
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
})

describe('surfaces without fields', () => {
  test('mobile draws the feed and points to commands instead of an input', async ($, on) => {
    const w = world(on)
    tools(on, w)
    await start($)
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'mobile', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    expect(await ui.find({ text: /\/inloop <question>/ })).toBeDefined()
    await ui.press({ key: 'tab:settings' })
    expect(await ui.find({ text: /inloop-mode/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('lifecycle', () => {
  test('a second session.start (a reload) does not double-process edits', async ($, on) => {
    const w = world(on)
    tools(on, w)
    await start($)
    await start($)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    expect((w.get('cards') ?? []).length).toBe(1)
    expect(w.prompts.length).toBe(1)
    // The same change seen again (an undo and redo) is not explained twice.
    const e = editTokens()
    await $.tool.call({ tool: 'Edit', file_path: e.file_path, old_string: e.new_string, new_string: e.old_string } as never)
    await w.clock.advance(10_000)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    const titles = (w.get('cards') ?? []).map(c => c.title)
    expect(titles.length).toBe(2)
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
    expect(w.get('narration')).toBe(null)
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
    expect(w.get('narration')).toBe(null)
    expect(w.said.map(x => x.text)).toEqual(['The agent added refreshToken.', 'refreshToken checks the old token first.', 'refreshToken checks the old token first.'])
    expect(w.said.every(x => x.isCut)).toBe(true)
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
    expect(w.get('narration')).toBe(null)
    expect(w.said.at(-1)?.isCut).toBe(true)
    await ui.unmount()
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
    expect(w.get('narration')).toBe(null)
    await band.unmount()
  })

})

