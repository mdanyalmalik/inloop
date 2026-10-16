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
  /** The files as committed at HEAD. */
  head: Map<string, string>
  /** Every commit's tree by sha, the last one HEAD; commit() makes one of the working files. */
  commits: { sha: string; tree: Map<string, string> }[]
  commit: () => void
  /** A model call to fail, by its count from 1: the reason (and status) it fails with, or undefined to answer. */
  failModel: (call: number) => { reason: string; status?: number; error?: string } | undefined
  prompts: { model: string; prompt: string; system: string }[]
  reads: string[]
  writes: string[]
  toasts: string[]
  logs: string[]
  spoken: string[]
  voicesUsed: (string | undefined)[]
  /** Each `say` started: its text and voice, and whether it was cut off. */
  said: { text: string; voice?: string; isCut: boolean }[]
  /** Ends the piece being spoken, as if `say` or `afplay` reached its end. */
  finishSpeech: () => void
  /** The folder the session runs in. */
  root: string
  /** Whether a fake `uv` with Kokoro set up is on this machine. */
  kokoro: boolean
  /** Kokoro clip paths, to the text each was rendered from. */
  clips: Map<string, string>
  /** The audio players this machine has (macOS: afplay; a Linux box might have paplay). */
  players: string[]
  /** Whether macOS's `say` exists; elsewhere speech goes to the platform synthesizer. */
  hasSay: boolean
  /** The player each clip was handed to. */
  playersUsed: string[]
  /** The player starts but cannot play (no sound device): it exits non-zero. */
  isPlayerBroken: boolean
  /** With `kokoro` (uv present): whether its model is downloaded yet. */
  isKokoroInstalled: boolean
  /** How many times setup ran; while `isSetupHeld`, it waits for releaseSetup() (a long download). */
  setupRuns: number
  isSetupHeld: boolean
  releaseSetup: () => void
  /** While true, Kokoro renders nothing until releaseRender() (a slow first render). */
  isRenderHeld: boolean
  releaseRender: () => void
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

function hashText(text: string): string {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(16)
}

const PLAYERS = ['afplay', 'pw-play', 'paplay', 'aplay', 'ffplay', 'powershell']

export function world(
  on: On,
  reply: (prompt: string) => string = () => '{"worth_explaining": true, "title": "T", "summary": "S", "key_lines": []}',
  store: Record<string, unknown> = {},
): World {
  const w: World = {
    files: new Map(Object.entries(DEMO_HEAD)),
    head: new Map(Object.entries(DEMO_HEAD)),
    commits: [],
    commit: () => undefined,
    failModel: () => undefined,
    prompts: [],
    reads: [],
    writes: [],
    toasts: [],
    logs: [],
    spoken: [],
    voicesUsed: [],
    said: [],
    finishSpeech: () => undefined,
    root: ROOT,
    kokoro: false,
    clips: new Map(),
    players: ['afplay'],
    hasSay: true,
    playersUsed: [],
    isPlayerBroken: false,
    isKokoroInstalled: true,
    setupRuns: 0,
    isSetupHeld: false,
    releaseSetup: () => undefined,
    isRenderHeld: false,
    releaseRender: () => undefined,
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
  // Most tests read explanations: they start written, as a person who chose it would. Spoken is the default.
  w.stored.set('settings', { style: 'written' })
  for (const [key, value] of Object.entries(store)) w.stored.set(key, value)
  w.commits.push({ sha: 'c0', tree: new Map(w.head) })
  w.commit = () => {
    w.head = new Map(w.files)
    w.commits.push({ sha: `c${w.commits.length}`, tree: new Map(w.files) })
  }
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
  on('turn.complete', () => ({ text: '' }) as never)
  on('env.get', () => ({ value: '/virtual/home' }))
  on('session.root', () => ({ value: w.root }))
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
  on('process.run', async ($, e) => {
    const argv = [...e.argv]
    w.gitCalls.push(argv)
    const args = argv.filter(a => a !== '-c' && a !== 'core.quotepath=off' && a !== '--no-pager').slice(1)
    const ok = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] === 'say') {
      if (!w.hasSay) throw new Error('spawn say ENOENT')
      return ok(SAY_LISTING)
    }
    if (PLAYERS.includes(argv[0] ?? '')) {
      if (!w.players.includes(argv[0]!)) throw new Error(`spawn ${argv[0]} ENOENT`)
      return ok('')
    }
    if (argv[0] === 'uv') {
      if (!w.kokoro) return ok('', 127, 'uv: not found')
      if (argv[1] === '--version') return ok('uv 0.8.0\n')
      if (argv.includes('status')) return ok(`{"ready": ${w.isKokoroInstalled}}\n`)
      if (argv.includes('setup')) {
        w.setupRuns++
        if (w.isSetupHeld) await new Promise<void>(resolve => { w.releaseSetup = resolve })
        w.isKokoroInstalled = true
        return ok('ready\n')
      }
    }
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return ok('true\n')
    if (args[0] === 'ls-files') return ok([...w.files.keys()].join('\n') + '\n')
    if (args[0] === 'status') {
      const lines: string[] = []
      for (const [path, text] of w.files) {
        if (path === '.env') continue
        if (!w.head.has(path)) lines.push(`?? ${path}`)
        else if (w.head.get(path) !== text) lines.push(` M ${path}`)
      }
      for (const path of w.head.keys()) if (!w.files.has(path)) lines.push(` D ${path}`)
      return ok(lines.join('\n') + (lines.length > 0 ? '\n' : ''))
    }
    if (args[0] === 'show' && /^[0-9a-zA-Z]+:/.test(args[1] ?? '')) {
      const [rev = '', path = ''] = (args[1] ?? '').split(/:(.*)/s)
      const tree = rev === 'HEAD' ? w.head : w.commits.find(c => c.sha === rev)?.tree
      const text = tree?.get(path)
      return text === undefined ? ok('', 128, `fatal: path not in ${rev}`) : ok(text)
    }
    if (args[0] === 'rev-parse' && args.includes('HEAD')) return ok(`${w.commits.at(-1)!.sha}\n`)
    if (args[0] === 'diff' && args.includes('--name-only')) {
      const revs = args.filter(a => /^c\d+$/.test(a))
      const [a, b] = revs.map(r => w.commits.find(c => c.sha === r)!.tree)
      const paths = new Set([...a!.keys(), ...b!.keys()])
      return ok([...paths].filter(p => a!.get(p) !== b!.get(p)).join('\n') + '\n')
    }
    if (argv[1] === 'hash-object') {
      const paths = String(e.init?.stdin ?? "").split('\n').filter(Boolean)
      if (paths.some(p => !w.files.has(p))) return ok('', 128, 'fatal: could not open')
      return ok(paths.map(p => `h${hashText(w.files.get(p)!)}`).join('\n') + '\n')
    }
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
    const failure = w.failModel(w.prompts.length)
    if (failure !== undefined) return { value: { isAnswered: false, ...failure, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } } as never
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
    if (argv[0] === 'uv' && argv.includes('synth')) {
      // Kokoro renders every text and prints each clip's path.
      const texts = JSON.parse(e.input ?? '[]') as string[]
      const voice = argv[argv.indexOf('synth') + 1]
      if (w.isRenderHeld) await new Promise<void>(resolve => { w.releaseRender = resolve })
      for (const [i, text] of texts.entries()) {
        const path = `/virtual/tts/${w.clips.size}-${i}.wav`
        w.clips.set(path, `${voice}|${text}`)
        yield { stream: 'stdout', text: `${path}\n` }
      }
      return { value: { code: 0, signal: null } }
    }
    if (argv[0] === 'say' && !w.hasSay) throw new Error('spawn say ENOENT')
    if (PLAYERS.includes(argv[0] ?? '') && !w.players.includes(argv[0]!)) throw new Error(`spawn ${argv[0]} ENOENT`)
    const v = argv.indexOf('-v')
    const clipPath = PLAYERS.includes(argv[0] ?? '') ? argv.find(a => w.clips.has(a)) ?? argv.map(a => /'(\/virtual\/[^']+)'/.exec(a)?.[1]).find(p => p !== undefined) : undefined
    if (clipPath !== undefined) w.playersUsed.push(argv[0]!)
    if (clipPath !== undefined && w.isPlayerBroken) return { value: { code: 1, signal: null } }
    const clip = clipPath !== undefined ? w.clips.get(clipPath) : undefined
    const entry = clip !== undefined
      ? { text: clip.split('|')[1] ?? '', voice: `kokoro:${clip.split('|')[0]}`, isCut: false }
      : { text: e.input ?? '', voice: v >= 0 ? argv[v + 1] : undefined, isCut: false }
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
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
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
