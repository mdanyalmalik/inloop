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

describe('navigation', () => {
  test('back from code returns to the explanation it was opened from', async ($, on) => {
    const w = world(on, () => JSON.stringify({
      worth_explaining: true,
      title: 'Token refresh',
      summary: 'Adds refreshToken.',
      key_lines: [{ path: 'server/auth/tokens.js', line: 19, end_line: 23, label: 'refreshToken' }],
    }))
    tools(on, w)
    await start($)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    const card = (w.get('cards') ?? [])[0]!
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    // No back on the start screen.
    expect(await ui.find({ key: 'nav:back' })).toBe(undefined)
    await ui.press({ key: `feed:step:${card.id}:0:open` })
    expect(w.get('tab')).toBe('code')
    expect(w.get('viewer')?.line).toBe(19)
    // From the code, follow a call to another file, then come back twice.
    await ui.press({ key: 'code:callee:0' })
    const followed = w.get('viewer')!
    expect(followed.path === 'server/auth/tokens.js' && followed.line === 19).toBe(false)
    await ui.press({ key: 'nav:back' })
    expect(w.get('tab')).toBe('code')
    expect(w.get('viewer')?.line).toBe(19)
    await ui.press({ key: 'nav:back' })
    expect(w.get('tab')).toBe('feed')
    expect(w.get('expanded')).toBe(card.id)
    expect(await ui.find({ text: /Adds refreshToken/ })).toBeDefined()
    expect(await ui.find({ key: 'nav:back' })).toBe(undefined)
    await ui.unmount()
  })

  test('back from a tab with no history goes to the feed; scrolling stops at the file end', async ($, on) => {
    const w = world(on)
    tools(on, w)
    await start($)
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    await ui.press({ key: 'tab:settings' })
    await ui.press({ key: 'nav:back' })
    expect(w.get('tab')).toBe('feed')
    await $.command.run({ command: 'inloop-explain', args: 'server/auth/tokens.js:6' } as never)
    await ui.press({ key: 'tab:code' })
    for (let i = 0; i < 20; i++) await ui.press({ key: 'code:down' })
    const lines = DEMO_HEAD['server/auth/tokens.js']!.split('\n').length
    // The 19-line file fits in the window: nothing to scroll past.
    expect(lines < 24).toBe(true)
    expect(w.get('viewer')!.top).toBe(1)
    await ui.press({ key: 'code:up' })
    expect(w.get('viewer')!.top).toBe(1)
    await ui.unmount()
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

  test('spoken: each part is read with its code on screen, with the best voice and no paths', async ($, on) => {
    const w = world(on, STEPPED)
    tools(on, w)
    await start($)
    await $.command.run({ command: 'inloop-style', args: 'spoken' } as never)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    // The title is read first; then part 1, its code in the pinned box.
    expect(w.get('narration')?.index).toBe(-1)
    w.finishSpeech()
    await w.clock.advance(1)
    expect(w.get('narration')?.index).toBe(0)
    expect(await ui.find({ text: /part 1 of 2/ })).toBeDefined()
    expect(await ui.find({ text: /const claims = verifyToken\(token\)/ })).toBeDefined()
    w.finishSpeech()
    await w.clock.advance(1)
    expect(w.get('narration')?.index).toBe(1)
    w.finishSpeech()
    await w.clock.advance(1)
    expect(w.get('narration')).toBe(null)
    expect(w.said.map(x => x.text)).toEqual(['Token refresh.', 'refreshToken checks the old token first.', 'It is exported next to createToken.'])
    expect(w.said.every(x => !x.isCut)).toBe(true)
    expect(w.said.at(-1)?.voice).toBe('Zoe (Premium)')
    await ui.unmount()
  })

  test('spoken controls cut speech off: next skips a part, pause and resume repeat it, stop ends', async ($, on) => {
    const w = world(on, STEPPED)
    tools(on, w)
    await start($)
    await $.command.run({ command: 'inloop-style', args: 'spoken' } as never)
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    const ui = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'Pane', requestId: 'inloop', props: PANE_PROPS as never })
    await ui.press({ key: 'say:next' })
    await w.clock.advance(1)
    expect(w.get('narration')?.index).toBe(0)
    await ui.press({ key: 'say:pause' })
    await w.clock.advance(1)
    expect(w.get('narration')?.isPaused).toBe(true)
    expect(w.said.length).toBe(2)
    await ui.press({ key: 'say:resume' })
    await w.clock.advance(1)
    expect(w.get('narration')?.index).toBe(0)
    await ui.press({ key: 'say:stop' })
    await w.clock.advance(1)
    expect(w.get('narration')).toBe(null)
    expect(w.said.map(x => x.text)).toEqual(['Token refresh.', 'refreshToken checks the old token first.', 'refreshToken checks the old token first.'])
    expect(w.said.every(x => x.isCut)).toBe(true)
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

  test('spoken, with the pane hidden: the part and its code show above the prompt', async ($, on) => {
    const w = world(on, STEPPED)
    tools(on, w)
    await start($)
    await $.command.run({ command: 'inloop-style', args: 'spoken' } as never)
    w.pane = 'behind'
    await $.tool.call({ tool: 'Edit', ...editTokens() } as never)
    await w.clock.advance(10_000)
    w.finishSpeech()
    await w.clock.advance(1)
    const band = await $.ui.mount({ plugin: 'inloop', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100 } as never })
    expect(await band.find({ text: /1\/2/ })).toBeDefined()
    expect(await band.find({ text: /refreshToken checks the old token first/ })).toBeDefined()
    expect(await band.find({ text: /const claims = verifyToken\(token\)/ })).toBeDefined()
    await band.press({ key: 'band:stop' })
    await w.clock.advance(1)
    expect(w.get('narration')).toBe(null)
    await band.unmount()
  })

})

