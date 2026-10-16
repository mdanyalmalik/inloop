// A virtual project beneath the plugin: files, a read-only git, a store, a
// clock and a scripted model, so the hooks run against the engine exactly as
// in a session with nothing real touched.

import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'

import type { InloopState } from '../src/host'
import { DEMO_HEAD } from './fixtures'

export const ROOT = '/virtual/demo'

/** What `say -v '?'` prints on a Mac with one Premium voice downloaded. */
export const SAY_LISTING = [
  'Albert              en_US    # Hello! My name is Albert.',
  'Bubbles             en_US    # Hello! My name is Bubbles.',
  'Daniel (English (UK)) en_GB    # Hello! My name is Daniel.',
  'Eddy (English (US)) en_US    # Hello! My name is Eddy.',
  'Samantha            en_US    # Hello! My name is Samantha.',
  'Zoe (Premium)       en_US    # Hello! My name is Zoe.',
  'Thomas              fr_FR    # Bonjour, je m’appelle Thomas.',
].join('\n')

export type World = {
  files: Map<string, string>
  prompts: { model: string; prompt: string; system: string }[]
  reads: string[]
  writes: string[]
  toasts: string[]
  logs: string[]
  spoken: string[]
  voicesUsed: (string | undefined)[]
  /** Each `say` started: its text and voice, and whether it was cut off. */
  said: { text: string; voice?: string; isCut: boolean }[]
  /** Ends the piece being spoken, as if `say` reached its end. */
  finishSpeech: () => void
  /** The inloop pane: in front, open behind another panel, or closed. */
  pane: 'shown' | 'behind' | 'closed'
  /** Base system prompt sections the engine would compose. */
  sections: { id: string; text: string; scope: 'shared' | 'session' }[]
  gitCalls: string[][]
  reply: (prompt: string) => string
  classify: string
  clock: ReturnType<typeof mock.clock>
  /** The latest value the plugin wrote under each of its state keys. */
  state: Map<string, unknown>
  /** The latest value written to the plugin store under each key. */
  stored: Map<string, unknown>
  get: <K extends keyof InloopState>(key: K) => InloopState[K] | undefined
}

export function world(
  on: On,
  reply: (prompt: string) => string = () => '{"worth_explaining": true, "title": "T", "summary": "S", "key_lines": []}',
  store: Record<string, unknown> = {},
): World {
  const w: World = {
    files: new Map(Object.entries(DEMO_HEAD)),
    prompts: [],
    reads: [],
    writes: [],
    toasts: [],
    logs: [],
    spoken: [],
    voicesUsed: [],
    said: [],
    finishSpeech: () => undefined,
    pane: 'shown',
    sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }],
    gitCalls: [],
    reply,
    classify: 'unrelated',
    clock: mock.clock(on, { now: 1_000_000 }),
    state: new Map(),
    stored: new Map(),
    get: key => w.state.get(key) as never,
  }
  on('state.set', ($, e, next) => {
    const write = e as unknown as { plugin: string; key: string; value: unknown }
    if (write.plugin === 'inloop') w.state.set(write.key, write.value)
    return next(e)
  })
  w.files.set('.env', 'JWT_SECRET=never-read-this-value')
  for (const [key, value] of Object.entries(store)) w.stored.set(key, value)
  on('store.get', ($, e) => ({ value: structuredClone(w.stored.get(e.key)) }))
  on('store.set', ($, e) => {
    w.stored.set(e.key, structuredClone(e.value))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    w.stored.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...w.stored.keys()] }))
  const rel = (path: string) => (path.startsWith(ROOT + '/') ? path.slice(ROOT.length + 1) : path)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('fs.read', ($, e) => {
    w.reads.push(rel(e.path))
    const text = w.files.get(rel(e.path))
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    w.writes.push(e.path)
    throw new Error('inloop must never write')
  })
  on('fs.list', () => ({ value: [] }))
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    w.gitCalls.push(argv)
    const args = argv.filter(a => a !== '-c' && a !== 'core.quotepath=off' && a !== '--no-pager').slice(1)
    const ok = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] === 'say') return ok(SAY_LISTING)
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return ok('true\n')
    if (args[0] === 'ls-files') return ok([...w.files.keys()].join('\n') + '\n')
    if (args[0] === 'grep') {
      const q = (args[args.indexOf('-e') + 1] ?? '').toLowerCase()
      const hits: string[] = []
      for (const [path, text] of w.files) {
        text.split('\n').forEach((line, i) => {
          if (line.toLowerCase().includes(q)) hits.push(`${path}:${i + 1}:${line}`)
        })
      }
      return ok(hits.join('\n'), hits.length > 0 ? 0 : 1)
    }
    return ok('', 128, `fatal: not mocked: git ${args.join(' ')}`)
  })
  on('model.complete', ($, e) => {
    w.prompts.push({ model: e.model, prompt: e.prompt, system: e.system ?? '' })
    return { value: { isAnswered: true, text: w.reply(e.prompt), usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } } as never
  })
  on('model.classify', () => ({ value: w.classify }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.panes', () => ({ value: w.pane === 'closed' ? [] : [{ id: 'inloop', title: 'inloop', isShown: w.pane === 'shown', isFocused: false, isPlaced: true }] }) as never)
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.selection', () => ({ value: undefined }))
  // `say`: a piece is spoken until the test calls finishSpeech(), or until inloop cuts it off.
  on('process.spawn', async function* ($, e, next) {
    const argv = [...e.argv]
    const v = argv.indexOf('-v')
    const entry = { text: e.input ?? '', voice: v >= 0 ? argv[v + 1] : undefined, isCut: false }
    w.said.push(entry)
    await new Promise<void>(resolve => {
      w.finishSpeech = resolve
      next.signal.addEventListener('abort', () => {
        entry.isCut = true
        resolve()
      })
    })
    yield* []
    return { value: { code: 0, signal: null } }
  })
  on('prompt.compose', () => ({ sections: w.sections }))
  on('audio.speak', ($, e) => {
    w.spoken.push(e.text)
    w.voicesUsed.push((e as unknown as { options?: { voice?: string }; voice?: string }).options?.voice ?? (e as unknown as { voice?: string }).voice)
    return { value: { synthesizer: 'say' } } as never
  })
  return w
}

export async function start($: { session: { start: (e: { cwd: string; surface: 'terminal'; isInteractive: boolean }) => Promise<unknown> } }): Promise<void> {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
}
