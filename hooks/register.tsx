// inloop's hooks module: observes the coding agent's edits, serves the
// /inloop commands, and draws the inloop pane. It answers for itself and never
// changes what the coding agent sees or does.

import type { Register } from 'claude-code'
import { atom, read, update } from 'claude-code'

import { App, EDIT_TOOLS, PANE } from '../src/app'
import { isNoise, isSensitive, toRelative } from '../src/security'
import type { Host } from '../src/host'
import { narrationBand, renderPane, type Snapshot } from '../src/ui'
import { DEFAULT_SETTINGS } from '../src/state'
import type { InloopCard, InloopDepth, InloopMode, InloopTab } from '../types'
import { describeFlow } from '../src/explain'
import { describePlan, KOKORO_VOICES, rankVoices } from '../src/voices'
import { READER_NAME, READER_PROMPT, READER_TYPE, readerHooks } from '../src/reader'

const cardsAtom = atom({ plugin: 'inloop', key: 'cards' } as const, [])
const historyAtom = atom({ plugin: 'inloop', key: 'history' } as const, [])
const tabAtom = atom({ plugin: 'inloop', key: 'tab' } as const, 'feed')
const expandedAtom = atom({ plugin: 'inloop', key: 'expanded' } as const, null)
const viewerAtom = atom({ plugin: 'inloop', key: 'viewer' } as const, null)
const navAtom = atom({ plugin: 'inloop', key: 'nav' } as const, [])
const flowAtom = atom({ plugin: 'inloop', key: 'flow' } as const, null)
const flowSelectedAtom = atom({ plugin: 'inloop', key: 'flowSelected' } as const, null)
const flowNoteAtom = atom({ plugin: 'inloop', key: 'flowNote' } as const, null)
const convoAtom = atom({ plugin: 'inloop', key: 'convo' } as const, [])
const settingsAtom = atom({ plugin: 'inloop', key: 'settings' } as const, DEFAULT_SETTINGS)
const askOpenAtom = atom({ plugin: 'inloop', key: 'askOpen' } as const, null)
const ctxAtom = atom({ plugin: 'inloop', key: 'ctx' } as const, {})
const gitAtom = atom({ plugin: 'inloop', key: 'git' } as const, { query: '', commits: [], files: [] })
const usageAtom = atom({ plugin: 'inloop', key: 'usage' } as const, { calls: 0, inputTokens: 0, outputTokens: 0 })
const narrationAtom = atom({ plugin: 'inloop', key: 'narration' } as const, null)
const frameAtom = atom({ plugin: 'inloop', key: 'frame' } as const, 0)
const changesAtom = atom({ plugin: 'inloop', key: 'changes' } as const, { since: 0, files: [] })
const statusAtom = atom({ plugin: 'inloop', key: 'status' } as const, { busy: null, queued: 0, pendingChanges: 0, recentBatches: 0 })

const BRIEF_REPLIES = `inloop is open beside this conversation. It explains every code change you make, with the code, in its own panel, so do not duplicate that work.
When you finish work that changed code, reply in at most two short sentences saying what you did, in plain words. Then add only what the person must act on, if anything: an error, a failing or skipped test, a question you need answered, a decision for them.
Do not include in these replies: code blocks, lists of changes, file-by-file summaries, explanations of how the code works, design rationale, or edge cases. inloop covers all of that.
If the person explicitly asks you to explain something, explain it fully.
This applies only to your messages to the person, not to reports you hand back to another agent.`

/** Rides each prompt while inloop is active, where the model weighs it most. */
const BRIEF_REMINDER = 'inloop is showing the person explanations of every change. Keep your final reply to at most two short sentences, plus anything they must act on. No code blocks, change lists, or explanations of how the code works, unless they explicitly ask for an explanation.'

const ACK = '(inloop is handling this in its own pane; it is not a request for the coding agent.)'

const COMMANDS: { name: string; description: string; argumentHint?: string }[] = [
  { name: 'inloop', description: 'Open the inloop pane, or ask it a question about the code', argumentHint: '[question]' },
  { name: 'inloop-explain', description: 'Explain the selected code, a file or function, or a topic', argumentHint: '[topic | path[:line] | symbol]' },
  { name: 'inloop-flow', description: 'Trace the execution flow of a feature through the code', argumentHint: '<feature, e.g. "user logs in">' },
  { name: 'inloop-commit', description: 'Explain a git commit (sha or message words)', argumentHint: '<sha | words>' },
  { name: 'inloop-compare', description: 'Compare two revisions, optionally about one topic', argumentHint: '<from> <to> [topic]' },
  { name: 'inloop-recent', description: 'Summarise the meaningful changes of the last N minutes', argumentHint: '[minutes, default 10]' },
  { name: 'inloop-focus', description: 'Only explain changes about one topic (empty to leave focus mode)', argumentHint: '[topic]' },
  { name: 'inloop-mode', description: 'Set automatic explanations: auto, ask, focus or paused', argumentHint: '<auto|ask|focus|paused>' },
  { name: 'inloop-depth', description: 'Set explanation depth', argumentHint: '<beginner|intermediate|advanced>' },
  { name: 'inloop-at', description: 'Study the code as of a commit or date (no checkout); "working" to return', argumentHint: '<sha | "3 months ago" | working>' },
  { name: 'inloop-history', description: 'Show saved explanations and bookmarks', argumentHint: '[words]' },
  { name: 'inloop-settings', description: 'Show and change inloop settings' },
  { name: 'inloop-style', description: 'Written explanations with code, or spoken ones that show the code as they go', argumentHint: '<written|spoken>' },
  { name: 'inloop-speak', description: 'Same as /inloop-style spoken (on) or written (off)', argumentHint: '<on|off>' },
  { name: 'inloop-brief', description: "Keep the coding agent's own replies short while inloop explains changes", argumentHint: '<on|off>' },
  { name: 'inloop-away', description: 'Stepping away: keep explaining changes, but hold them (audio for the next few made) until /inloop-play' },
  { name: 'inloop-play', description: "Back: read what was explained while you were away, oldest first" },
  { name: 'inloop-reload', description: 'Restart inloop if it seems to miss changes: looks at the project again and explains what it missed' },
  { name: 'inloop-voice', description: 'List voices, choose one, or set up the natural Kokoro voice', argumentHint: '[setup | voice | auto]' },
]

let app: App | null = null
/** The reader agents inloop started, by agentId, each waiting for its final message. */
const readers = new Map<string, { resolve: (text: string) => void; reject: (err: Error) => void }>()
/** Every reader agent this process started: their finishing notices are inloop's to keep. */
const readerIds = new Set<string>()
/** The reader's longest run before inloop answers without it. */
const READER_TIMEOUT_MS = 4 * 60_000
/** A -p or SDK run ends right after its turn: there, a turn waits for its explanation. */
let isHeadless = false

/**
 * Interactive: the work runs on and its result shows in the pane, so the
 * command answers at once. Headless (-p, SDK): no pane, the run would end
 * first, so the command waits and prints the result as its output.
 */
async function finish(start: () => Promise<unknown>, result: () => Promise<string>): Promise<{ text: string }> {
  if (!isHeadless) {
    // Off the command's own time: the work and its speech run on the plugin's timer.
    app?.detach(start)
    return { text: ACK }
  }
  await start()
  return { text: await result() }
}

/** The newest answer as plain text, with its references and any flow drawn. */
async function lastAnswer(withFlow = false): Promise<string> {
  if (app === null) return ''
  const turn = (await app.host.state.convo.get()).at(-1)
  if (turn === undefined) return 'No answer.'
  const refs = (turn.refs ?? []).map(r => `  ${r.path}${r.line !== undefined ? ':' + r.line : ''}${r.label !== undefined ? ' — ' + r.label : ''}`)
  const flow = withFlow ? await app.host.state.flow.get() : null
  return [turn.text, refs.length > 0 ? `\nCode:\n${refs.join('\n')}` : '', flow !== null ? `\nFlow:\n${describeFlow(flow)}` : ''].join('\n').trim()
}

async function cardText(card: Promise<InloopCard | null>): Promise<string> {
  const c = await card
  return c === null ? 'Nothing to explain.' : `${c.title}\n\n${c.summary}`
}

/** Shows a tab and asks for the pane; resolves whether a surface draws it. */
async function showTab(tab: InloopTab | undefined, open: () => Promise<{ isPlaced: boolean }>): Promise<boolean> {
  if (tab !== undefined && app !== null) await app.setTab(tab)
  return (await open()).isPlaced
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    isHeadless = !e.isInteractive
    app?.stop()
    // Kokoro runs through uv (an isolated environment, nothing installed system-wide).
    // Nothing about the voice may keep inloop from starting.
    const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
    let uv: string | undefined
    for (const candidate of ['uv', `${home}/.local/bin/uv`, '/opt/homebrew/bin/uv', '/usr/local/bin/uv']) {
      const probe = await $.process.run([candidate, '--version'], { timeoutMs: 4000 }).catch(() => undefined)
      if (probe?.exitCode === 0) {
        uv = candidate
        break
      }
    }
    const ttsScript = `${$.plugin.root}/voice/inloop_tts.py`
    // A player for Kokoro's clips, the first this machine has: macOS, then Linux
    // (PipeWire/PulseAudio, ALSA, FFmpeg), then Windows. A probe that cannot start means absent.
    const PLAYERS: { probe: string[]; play: (path: string) => string[] }[] = [
      { probe: ['afplay', '-h'], play: path => ['afplay', path] },
      { probe: ['pw-play', '--version'], play: path => ['pw-play', path] },
      { probe: ['paplay', '--version'], play: path => ['paplay', path] },
      { probe: ['aplay', '--version'], play: path => ['aplay', '-q', path] },
      { probe: ['ffplay', '-version'], play: path => ['ffplay', '-nodisp', '-autoexit', '-loglevel', 'quiet', path] },
      {
        probe: ['powershell', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'],
        play: path => ['powershell', '-NoProfile', '-NonInteractive', '-Command', `(New-Object Media.SoundPlayer '${path.replace(/'/g, "''")}').PlaySync()`],
      },
    ]
    let player: ((path: string) => string[]) | undefined
    for (const candidate of PLAYERS) {
      const probe = await $.process.run(candidate.probe, { timeoutMs: 5000 }).catch(() => undefined)
      if (probe !== undefined) {
        player = candidate.play
        break
      }
    }
    const host: Host = {
      root: () => $.session.root(),
      home: async () => home,
      readFile: async path => {
        const text = await $.fs.read(path)
        if (typeof text !== 'string') throw new Error(`${path} is not text`)
        return text
      },
      listDir: path => $.fs.list(path),
      run: (argv, init) => $.process.run(argv, init),
      complete: (request, options) => $.model.complete(request, options),
      classify: (text, labels, options) => $.model.classify(text, labels, options),
      storeGet: key => $.store.get(key),
      storeSet: (key, value) => $.store.set(key, value),
      state: {
        cards: { get: () => read($, cardsAtom), update: change => update($, cardsAtom, change) },
        history: { get: () => read($, historyAtom), update: change => update($, historyAtom, change) },
        tab: { get: () => read($, tabAtom), update: change => update($, tabAtom, change) },
        expanded: { get: () => read($, expandedAtom), update: change => update($, expandedAtom, change) },
        viewer: { get: () => read($, viewerAtom), update: change => update($, viewerAtom, change) },
        nav: { get: () => read($, navAtom), update: change => update($, navAtom, change) },
        flow: { get: () => read($, flowAtom), update: change => update($, flowAtom, change) },
        flowSelected: { get: () => read($, flowSelectedAtom), update: change => update($, flowSelectedAtom, change) },
        flowNote: { get: () => read($, flowNoteAtom), update: change => update($, flowNoteAtom, change) },
        convo: { get: () => read($, convoAtom), update: change => update($, convoAtom, change) },
        askOpen: { get: () => read($, askOpenAtom), update: change => update($, askOpenAtom, change) },
        settings: { get: () => read($, settingsAtom), update: change => update($, settingsAtom, change) },
        ctx: { get: () => read($, ctxAtom), update: change => update($, ctxAtom, change) },
        git: { get: () => read($, gitAtom), update: change => update($, gitAtom, change) },
        usage: { get: () => read($, usageAtom), update: change => update($, usageAtom, change) },
        status: { get: () => read($, statusAtom), update: change => update($, statusAtom, change) },
        narration: { get: () => read($, narrationAtom), update: change => update($, narrationAtom, change) },
        changes: { get: () => read($, changesAtom), update: change => update($, changesAtom, change) },
        frame: { get: () => read($, frameAtom), update: change => update($, frameAtom, change) },
      },
      status: text => $.ui.status(text),
      toast: (text, options) => $.ui.toast(text, options),
      log: text => $.ui.log(text),
      panes: () => $.ui.panes(),
      openPane: () => $.ui.open({ id: PANE, title: 'inloop', columns: 64 }),
      speak: (text, voice) => $.audio.speak(text, voice === undefined ? undefined : { voice }),
      say: (text, voice) => {
        // A spawned `say` can be cut off (stop, pause, skip); elsewhere the platform voice speaks it whole.
        let isStopped = false
        const voiceArgs = voice === undefined ? [] : ['-v', voice]
        const stream = $.process.spawn({ argv: ['say', ...voiceArgs], input: text })
        const done = (async () => {
          try {
            for await (const piece of stream) void piece
          } catch {
            if (!isStopped) await $.audio.speak(text, voice === undefined ? undefined : { voice }).catch(() => undefined)
          }
        })()
        const stop = () => {
          isStopped = true
          void stream.return(undefined as never).catch(() => undefined)
        }
        return { done, stop }
      },
      investigate: isHeadless ? undefined : async (prompt, description, model) => {
        const spawned = await $.agent.spawn({ subagentType: READER_TYPE, prompt, description, model } as never) as { agentId?: string; deny?: string }
        if (spawned.agentId === undefined) throw new Error(spawned.deny ?? 'the reader agent did not start')
        const id = spawned.agentId
        readerIds.add(id)
        return new Promise<string>((resolve, reject) => {
          const timer = $.clock.after(READER_TIMEOUT_MS, () => {
            readers.delete(id)
            reject(new Error('the reader agent took too long'))
          })
          readers.set(id, {
            resolve: text => { timer.cancel(); resolve(text) },
            reject: err => { timer.cancel(); reject(err) },
          })
        })
      },
      hasUv: uv !== undefined,
      canPlayClips: player !== undefined,
      kokoroReady: async () => {
        if (uv === undefined) return false
        const checked = await $.process.run([uv, 'run', '--offline', '--quiet', '--script', ttsScript, 'status'], { timeoutMs: 60_000 }).catch(() => undefined)
        return checked?.exitCode === 0 && checked.stdout.includes('"ready": true')
      },
      kokoroSetup: async () => {
        if (uv === undefined) return { ok: false, text: 'uv is not installed (https://docs.astral.sh/uv/).' }
        const done = await $.process.run([uv, 'run', '--quiet', '--script', ttsScript, 'setup'], { timeoutMs: 600_000 }).catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) }))
        return { ok: done.exitCode === 0, text: `${done.stdout}${done.stderr}` }
      },
      synthesize: (texts, voice, speed) => {
        if (uv === undefined) return { paths: (async function* () {})(), stop: () => undefined }
        const stream = $.process.spawn({
          argv: [uv, 'run', '--offline', '--quiet', '--script', ttsScript, 'synth', voice, String(speed)],
          input: JSON.stringify(texts),
        })
        async function* paths(): AsyncGenerator<string> {
          let held = ''
          for await (const piece of stream) {
            if (piece.stream !== 'stdout') continue
            held += piece.text
            for (let cut = held.indexOf('\n'); cut >= 0; cut = held.indexOf('\n')) {
              const line = held.slice(0, cut).trim()
              held = held.slice(cut + 1)
              if (line.endsWith('.wav')) yield line
            }
          }
        }
        return { paths: paths(), stop: () => void stream.return(undefined as never).catch(() => undefined) }
      },
      play: path => {
        if (player === undefined) return { done: Promise.reject(new Error('no audio player')), stop: () => undefined }
        const stream = $.process.spawn({ argv: player(path) })
        let isStopped = false
        const done = (async () => {
          let step = await stream.next()
          while (step.done !== true) step = await stream.next()
          // A player that could not play (no sound device, a format it lacks) exits non-zero.
          if (!isStopped && step.value.code !== 0) throw new Error(`the audio player exited with ${step.value.code ?? step.value.signal}`)
        })()
        const stop = () => {
          isStopped = true
          void stream.return(undefined as never).catch(() => undefined)
        }
        return { done, stop }
      },
      listVoices: async () => {
        const listed = await $.process.run(['say', '-v', '?'], { timeoutMs: 5000 }).catch(() => undefined)
        return listed?.exitCode === 0 ? listed.stdout : ''
      },
      after: (ms, fn) => $.clock.after(ms, fn),
      every: (ms, fn) => $.clock.every(ms, fn),
    }
    app = new App(host)
    app.isHeadless = isHeadless
    await app.start()
    for (const c of COMMANDS) await $.command.register({ ...c, immediate: true })
    // The reader: Claude Code's own way of finding and reading code, held to reading.
    if (!isHeadless) {
      await $.agent.register({
        name: READER_NAME,
        description: "inloop's internal read-only code reader. Never use it: inloop starts it itself.",
        prompt: READER_PROMPT,
        tools: ['Read', 'Grep', 'Glob', 'Bash'],
        // Nothing that needs a permission runs, and the guard holds it to reading
        // inside the project (inloop's own hooks are skipped for calls it caused).
        permissionMode: 'dontAsk',
        hooks: readerHooks($.plugin.root),
        maxTurns: 24,
        background: true,
        omitClaudeMd: true,
      }).catch(() => undefined)
    }
    // Seated only where the terminal is wide enough to dock it beside the transcript.
    void $.ui.open({ id: PANE, title: 'inloop', columns: 64 })
    return started
  })

  on('session.end', async ($, e, next) => {
    // Claude Code gives this hook about 1.5 s and cuts model calls off then, so no
    // explanation is started here: one would only end as a failed card. (A headless
    // run already waited for its explanations when its turn completed.)
    // After /clear or a resume the process goes on with no session.start, so inloop
    // starts over rather than staying stopped; at a real exit that costs nothing.
    app?.restart()
    return next(e)
  })

  // Observe edits: let the tool run untouched, then record what it did.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (app === null) return next(e)
    if (tool === 'Bash') {
      // A shell command can change files too (a script, sed, a formatter): look afterwards.
      const ran = await next(e)
      try {
        app.noteShell()
      } catch {
        // Observation never gets in the agent's way, nor runs its command twice.
      }
      return ran
    }
    if (!EDIT_TOOLS.has(tool)) return next(e)
    const input = e as unknown as Record<string, unknown>
    const path = String(input.file_path ?? input.notebook_path ?? '')
    const rel = path === '' ? null : toRelative(app.repo.root, path)
    const isReadable = rel !== null && !isSensitive(rel) && !isNoise(rel)
    // Write replaces the whole file: keep its text from before, for the diff.
    const before = tool === 'Write' && isReadable ? await $.fs.read(path).then(t => (typeof t === 'string' ? t : null), () => null) : undefined
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && path !== '') {
      try {
        // Edit's record keeps the file as it was: exact even where its new text is not unique, is empty,
        // or the person changed the proposed edit. (Null: there was no file; an empty old_string made it.)
        const original = (ran.result as { originalFile?: unknown } | undefined)?.originalFile
        const edited = tool !== 'Edit' || !isReadable ? before
          : typeof original === 'string' ? original
          : original === null && input.old_string === '' ? null
          : undefined
        app.recordEdit(tool, path, input, edited)
      } catch {
        // Observation never gets in the agent's way.
      }
    }
    return ran
  }).catch(($, e, next) => next(e))

  // The agent's turn ended: explain what is still batched.
  // While inloop is explaining each change where the person can see or hear it,
  // the coding agent need not say it all again. Otherwise its replies are left alone.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (app === null || !(await app.isBriefActive())) return composed
    return { sections: [...composed.sections, { id: 'inloop:brief-replies', text: BRIEF_REPLIES, scope: 'session' as const }] }
  })

  // The same, as a note beside each prompt the person types (the model never shows it).
  on('prompt.submit', async ($, e, next) => {
    // A reader finishing is inloop's news, not the coding agent's: its notice never reaches the conversation.
    // It comes as the subagent's hand-back (a peer message from its agentId) or a task notification naming it.
    const origin = (e as { origin?: { kind?: string; from?: string; senderTaskId?: string } }).origin
    const isReaders = origin !== undefined && (
      (origin.from !== undefined && readerIds.has(origin.from)) ||
      (origin.senderTaskId !== undefined && readerIds.has(origin.senderTaskId)) ||
      ((origin.kind === 'task-notification' || origin.kind === 'peer') && [...readerIds].some(id => e.text.includes(id))))
    if (isReaders) return { drop: "inloop's answer is in its pane" } as never
    if (app === null || e.command !== undefined || e.isMeta === true) return next(e)
    // After /clear the conversation's state starts fresh: settings and the feed come back first.
    await app.ensureState().catch(() => undefined)
    app.markPrompt()
    if (!(await app.isBriefActive())) return next(e)
    return next({ ...e, context: [...(e.context ?? []), BRIEF_REMINDER] })
  }).catch(($, e, next) => next(e))

  // Spoken style with the pane hidden (behind another panel, or closed): the
  // part being read and its code show above the prompt instead.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const narration = await read($, narrationAtom)
    if (narration === null || app === null || e.props.hasSurvey) return next(e)
    const panes = await $.ui.panes().catch(() => [])
    if (panes.some(p => p.id === PANE && p.isShown && p.isPlaced)) return next(e)
    return narrationBand($.ui.resolve(e), narration, app, e.props.bodyColumns, e.props.maxRows, await read($, frameAtom))
  })

  // The band follows the pane: hidden or shown again, it redraws. A pane the
  // person closed stays closed until they open it again.
  on('ui.close', ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person' && app !== null) app.isPaneClosedByPerson = true
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // A reader's final message is its answer.
    if (e.agentId !== undefined && readers.has(e.agentId)) {
      const waiting = readers.get(e.agentId)!
      readers.delete(e.agentId)
      if (e.isAborted) waiting.reject(new Error('the reader agent was stopped'))
      else waiting.resolve(e.answer)
    }
    if (e.agentId === undefined && app !== null) {
      if (isHeadless) await app.drain(60_000).catch(() => undefined)
      else {
        const live = app
        live.detach(() => live.flush('turn'))
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: 'inloop' }, async ($, e) => {
    if (app === null) {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>inloop is starting…</Text>
    }
    const snapshot: Snapshot = {
      tab: await read($, tabAtom),
      status: await read($, statusAtom),
      settings: await read($, settingsAtom),
      ctx: await read($, ctxAtom),
      cards: await read($, cardsAtom),
      expanded: await read($, expandedAtom),
      viewer: await read($, viewerAtom),
      nav: await read($, navAtom),
      flow: await read($, flowAtom),
      selected: await read($, flowSelectedAtom),
      note: await read($, flowNoteAtom),
      convo: await read($, convoAtom),
      askOpen: await read($, askOpenAtom),
      history: await read($, historyAtom),
      git: await read($, gitAtom),
      usage: await read($, usageAtom),
      narration: await read($, narrationAtom),
      changes: await read($, changesAtom),
      frame: await read($, frameAtom),
    }
    return renderPane({
      el: $.ui.resolve(e),
      surface: e.surface,
      s: snapshot,
      app,
      width: e.props.bodyColumns,
      rows: e.viewport?.rows ?? 40,
    })
  })

  on('command.run', { command: 'inloop' }, async ($, e) => {
    if (app === null) return { text: 'inloop is not ready yet.' }
    const q = e.args.trim()
    if (q === '') {
      app.isPaneClosedByPerson = false
      const placed = await showTab(undefined, () => $.ui.open({ id: PANE, title: 'inloop', columns: 64 }))
      return { text: placed ? 'Pane opened.' : 'The pane opens when the terminal is wide enough (fullscreen, ~110+ columns); commands still work.' }
    }
    void showTab('ask', () => $.ui.open({ id: PANE, title: 'inloop', columns: 64 }))
    const isFlow = /what happens when|\bflow\b|trace|follow/i.test(q)
    return finish(() => app!.ask(q, isFlow ? 'flow' : 'question'), () => lastAnswer(isFlow))
  }).catch(() => ({ text: 'that command failed; see the inloop pane for details.' }))

  on('command.run', { command: 'inloop-explain' }, async ($, e) => {
    if (app === null) return { text: 'inloop is not ready yet.' }
    const arg = e.args.trim()
    void showTab('ask', () => $.ui.open({ id: PANE, title: 'inloop', columns: 64 }))
    if (arg === '') {
      const ctx = await read($, ctxAtom)
      const selection = await $.ui.selection().catch(() => undefined)
      if (selection !== undefined && selection.text.trim() !== '') {
        return finish(() => app!.ask(`Explain this code I selected:\n\n${selection.text.slice(0, 4000)}`), () => lastAnswer())
      }
      if (ctx.path !== undefined) {
        return finish(() => app!.ask(`Explain ${ctx.symbol !== undefined ? `${ctx.symbol}() in ` : ''}${ctx.path} lines ${ctx.line ?? 1}-${ctx.endLine ?? ctx.line ?? 1}.`), () => lastAnswer())
      }
      const latest = (await read($, cardsAtom))[0]
      if (latest === undefined) return { text: 'Nothing selected yet. Pass a topic, a file or a function: /inloop-explain src/auth.js:12' }
      return finish(() => app!.ask(`Go deeper on "${latest.title}".`), () => lastAnswer())
    }
    const loc = /^([\w./@-]+\.\w+)(?::(\d+)(?:-(\d+))?)?$/.exec(arg)
    if (loc !== null) {
      const line = loc[2] !== undefined ? Number(loc[2]) : undefined
      await app.openRef({ path: loc[1]!, line, endLine: loc[3] !== undefined ? Number(loc[3]) : line }, { switchTab: false })
      return finish(() => app!.ask(line !== undefined ? `Explain ${loc[1]} around line ${line}: what this code does and how it connects to the rest.` : `Explain the file ${loc[1]}: its purpose, main functions and how it connects to the rest.`), () => lastAnswer())
    }
    return finish(() => app!.ask(arg), () => lastAnswer())
  }).catch(() => ({ text: 'that command failed; see the inloop pane for details.' }))

  on('command.run', { command: 'inloop-flow' }, async ($, e) => {
    if (app === null) return { text: 'inloop is not ready yet.' }
    const q = e.args.trim()
    if (q === '') return { text: 'Describe the feature: /inloop-flow what happens when a user logs in' }
    const quick = await app.quickFlow(q).catch(() => null)
    if (quick !== null) await app.showFlow(quick)
    void showTab('flow', () => $.ui.open({ id: PANE, title: 'inloop', columns: 64 }))
    return finish(() => app!.ask(q, 'flow'), () => lastAnswer(true))
  }).catch(() => ({ text: 'that command failed; see the inloop pane for details.' }))

  on('command.run', { command: 'inloop-commit' }, async ($, e) => {
    if (app === null) return { text: 'inloop is not ready yet.' }
    if (!app.repo.isGit) return { text: 'This project is not a git repository.' }
    const q = e.args.trim()
    let rev = q
    if (q === '') rev = 'HEAD'
    else if (!/^[0-9a-f]{4,40}$/i.test(q) && !/^HEAD([~^]\d*)*$/.test(q)) {
      const found = await app.repo.log({ query: q, limit: 1 }).catch(() => [])
      if (found[0] === undefined) return { text: `No commit message matches "${q}".` }
      rev = found[0].sha
    }
    void showTab('feed', () => $.ui.open({ id: PANE, title: 'inloop', columns: 64 }))
    const live = app
    let card: Promise<InloopCard | null> = Promise.resolve(null)
    return finish(() => (card = live.explainCommit(rev)), () => cardText(card))
  }).catch(() => ({ text: 'that command failed; see the inloop pane for details.' }))

  on('command.run', { command: 'inloop-compare' }, async ($, e) => {
    if (app === null) return { text: 'inloop is not ready yet.' }
    const [from, to, ...topic] = e.args.trim().split(/\s+/)
    if (from === undefined || from === '' || to === undefined) return { text: 'Usage: /inloop-compare <from> <to> [topic]' }
    if (!app.repo.isGit) return { text: 'This project is not a git repository.' }
    void showTab('feed', () => $.ui.open({ id: PANE, title: 'inloop', columns: 64 }))
    const live = app
    let card: Promise<InloopCard | null> = Promise.resolve(null)
    return finish(() => (card = live.compare(from, to, topic.join(' '))), () => cardText(card))
  }).catch(() => ({ text: 'that command failed; see the inloop pane for details.' }))

  on('command.run', { command: 'inloop-recent' }, async ($, e) => {
    if (app === null) return { text: 'inloop is not ready yet.' }
    const minutes = Math.max(1, Math.min(600, Number.parseInt(e.args.trim() || '10', 10) || 10))
    void showTab('feed', () => $.ui.open({ id: PANE, title: 'inloop', columns: 64 }))
    const live = app
    let card: Promise<InloopCard | null> = Promise.resolve(null)
    const start = () => (card = live.explainRecent(minutes).then(c => {
      if (c === null) live.host.log(`inloop: no recorded changes in the last ${minutes} minutes.`)
      return c
    }))
    return finish(start, () => cardText(card))
  }).catch(() => ({ text: 'that command failed; see the inloop pane for details.' }))

  on('command.run', { command: 'inloop-focus' }, async ($, e) => {
    if (app === null) return { text: 'inloop is not ready yet.' }
    const topic = e.args.trim()
    if (topic === '') {
      await app.setSettings({ focus: '', mode: 'auto' })
      return { text: 'focus cleared; back to automatic mode.' }
    }
    await app.setSettings({ focus: topic, mode: 'focus' })
    return { text: `only changes about "${topic}" will be explained automatically.` }
  }).catch(() => ({ text: 'that command failed; see the inloop pane for details.' }))

  on('command.run', { command: 'inloop-mode' }, async ($, e) => {
    if (app === null) return { text: 'inloop is not ready yet.' }
    const mode = e.args.trim().toLowerCase() as InloopMode
    if (!['auto', 'ask', 'focus', 'paused'].includes(mode)) {
      const s = await read($, settingsAtom)
      return { text: `Mode is ${s.mode}. Use /inloop-mode auto|ask|focus|paused` }
    }
    await app.setSettings({ mode })
    return { text: `Mode: ${mode}.` }
  }).catch(() => ({ text: 'that command failed; see the inloop pane for details.' }))

  on('command.run', { command: 'inloop-away' }, async () => {
    if (app === null) return { text: 'inloop is not ready yet.' }
    return { text: await app.goAway() }
  }).catch(() => ({ text: 'that command failed; see the inloop pane for details.' }))

  on('command.run', { command: 'inloop-play' }, async () => {
    if (app === null) return { text: 'inloop is not ready yet.' }
    return { text: await app.comeBack() }
  }).catch(() => ({ text: 'that command failed; see the inloop pane for details.' }))

  on('command.run', { command: 'inloop-depth' }, async ($, e) => {
    if (app === null) return { text: 'inloop is not ready yet.' }
    const depth = e.args.trim().toLowerCase() as InloopDepth
    if (!['beginner', 'intermediate', 'advanced'].includes(depth)) {
      const s = await read($, settingsAtom)
      return { text: `Depth is ${s.depth}. Use /inloop-depth beginner|intermediate|advanced` }
    }
    await app.setSettings({ depth })
    return { text: `Depth: ${depth}.` }
  }).catch(() => ({ text: 'that command failed; see the inloop pane for details.' }))

  on('command.run', { command: 'inloop-at' }, async ($, e) => {
    if (app === null) return { text: 'inloop is not ready yet.' }
    try {
      return { text: `${await app.studyRevision(e.args)}` }
    } catch (err) {
      return { text: `${String((err as Error).message ?? err)}` }
    }
  }).catch(() => ({ text: 'that command failed; see the inloop pane for details.' }))

  on('command.run', { command: 'inloop-history' }, async ($, e) => {
    if (app === null) return { text: 'inloop is not ready yet.' }
    const q = e.args.trim().toLowerCase()
    const history = await read($, historyAtom)
    const hits = history.filter(c => q === '' || `${c.title} ${c.concept ?? ''} ${c.summary}`.toLowerCase().includes(q))
    const placed = await showTab('history', () => $.ui.open({ id: PANE, title: 'inloop', columns: 64 }))
    if (!placed) {
      $.ui.log(hits.length === 0 ? 'No saved explanations match.' :
        hits.slice(0, 20).map(c => `${c.bookmarked === true ? '★' : '·'} ${new Date(c.at).toISOString().slice(0, 16)} ${c.title}`).join('\n'))
    }
    return { text: `${hits.length} saved explanation${hits.length === 1 ? '' : 's'}${q !== '' ? ` matching "${q}"` : ''}.` }
  }).catch(() => ({ text: 'that command failed; see the inloop pane for details.' }))

  on('command.run', { command: 'inloop-settings' }, async ($, e) => {
    if (app === null) return { text: 'inloop is not ready yet.' }
    const s = await read($, settingsAtom)
    await showTab('settings', () => $.ui.open({ id: PANE, title: 'inloop', columns: 64 }))
    return {
      text: `inloop: mode ${s.mode}${s.focus ? ` (focus: ${s.focus})` : ''}, depth ${s.depth}, automatic cards by ${s.autoEngine === 'model' ? s.autoModel : 'static analysis'}, questions by ${s.askModel}, min significance ${s.minScore}, quiet ${s.quietSeconds}s, style ${s.style}, brief agent replies ${s.briefAgent ? 'on' : 'off'}.`,
    }
  }).catch(() => ({ text: 'that command failed; see the inloop pane for details.' }))

  on('command.run', { command: 'inloop-voice' }, async ($, e) => {
    if (app === null) return { text: 'inloop is not ready yet.' }
    const live = app
    const want = e.args.trim()
    if (want === 'setup') {
      // What cannot be set up here is said at once, not after a pretend start.
      if (!live.host.hasUv || !live.host.canPlayClips || live.canUseKokoro) return { text: await live.setupKokoro() }
      if (!isHeadless) {
        live.detach(async () => live.host.log(`inloop: ${await live.setupKokoro()}`))
        return { text: 'Installing the Kokoro voice (one-time download, ~200 MB); inloop says when it is ready.' }
      }
      return { text: await live.setupKokoro() }
    }
    const voices = await live.refreshVoices()
    const s = await read($, settingsAtom)
    if (want === '') {
      const kokoro = live.canUseKokoro ? KOKORO_VOICES.map(v => `  kokoro:${v.id}  ${v.label}`) : []
      const system = rankVoices(voices).slice(0, 10).map(v => `  ${v.name}${v.quality === 'premium' || v.quality === 'enhanced' ? ` (${v.quality})` : ''}`)
      return {
        text: [
          `Speaking with: ${describePlan(live.voicePlan(s.voice))}${s.voice === '' ? ' (automatic)' : ''}`,
          kokoro.length > 0 ? `Kokoro voices (natural, local):\n${kokoro.join('\n')}` : 'Kokoro is not set up: /inloop-voice setup installs it (free, local, ~200 MB once).',
          system.length > 0 ? `Mac voices:\n${system.join('\n')}` : '',
        ].filter(Boolean).join('\n\n'),
      }
    }
    const say = 'This is the voice inloop will use.'
    if (want === 'auto') {
      await live.setSettings({ voice: '' })
      live.detach(() => live.speak(say))
      return { text: `Voice: automatic (${describePlan(live.voicePlan(''))}).` }
    }
    const lower = want.toLowerCase().replace(/^kokoro:/, '')
    const kokoro = KOKORO_VOICES.find(v => v.id === lower || v.label.toLowerCase().startsWith(lower))
    if (kokoro !== undefined) {
      if (!live.canUseKokoro) return { text: live.isKokoroReady ? 'This machine has no audio player for Kokoro; see /inloop-voice setup.' : 'Kokoro is not set up yet: /inloop-voice setup' }
      await live.setSettings({ voice: `kokoro:${kokoro.id}` })
      live.detach(() => live.speak(say))
      return { text: `Voice: ${kokoro.label} (Kokoro).` }
    }
    const match = voices.find(v => v.name.toLowerCase() === lower) ?? voices.find(v => v.name.toLowerCase().startsWith(lower))
    if (match === undefined) return { text: `No voice named "${want}". /inloop-voice lists them.` }
    await live.setSettings({ voice: match.name })
    live.detach(() => live.speak(say))
    return { text: `Voice: ${match.name}.` }
  }).catch(() => ({ text: 'That command failed.' }))

  on('command.run', { command: 'inloop-style' }, async ($, e) => {
    if (app === null) return { text: 'inloop is not ready yet.' }
    const want = e.args.trim().toLowerCase()
    if (want !== 'written' && want !== 'spoken') {
      const s = await read($, settingsAtom)
      return { text: `Style is ${s.style}. Use /inloop-style written (explanations with code, to read) or /inloop-style spoken (read aloud, the code shown as each part is discussed).` }
    }
    await app.setSettings({ style: want })
    if (want === 'spoken') app.detach(() => app!.speak('inloop will talk you through each change, showing the code as it goes.'))
    return { text: want === 'spoken' ? 'Spoken: new explanations are read aloud, with the code for each part shown in the panel.' : 'Written: new explanations appear in the panel with their code.' }
  }).catch(() => ({ text: 'that command failed; see the inloop pane for details.' }))

  on('command.run', { command: 'inloop-speak' }, async ($, e) => {
    if (app === null) return { text: 'inloop is not ready yet.' }
    const v = e.args.trim().toLowerCase()
    const s = await read($, settingsAtom)
    const isOn = v === '' ? s.style !== 'spoken' : v === 'on' || v === 'true' || v === 'yes'
    await app.setSettings({ style: isOn ? 'spoken' : 'written' })
    if (isOn) app.detach(() => app!.speak('inloop will talk you through each change, showing the code as it goes.'))
    return { text: isOn ? 'Spoken style on.' : 'Written style (speech off).' }
  }).catch(() => ({ text: 'that command failed; see the inloop pane for details.' }))

  on('command.run', { command: 'inloop-reload' }, async () => {
    if (app === null) return { text: 'inloop has not started in this session; run /reload-plugins.' }
    const live = app
    let said = ''
    return finish(
      async () => {
        said = await live.reload()
        if (!isHeadless) live.host.toast(said, { timeoutMs: 6000 })
      },
      async () => said,
    )
  }).catch(() => ({ text: 'that command failed; see the inloop pane for details.' }))

  on('command.run', { command: 'inloop-brief' }, async ($, e) => {
    if (app === null) return { text: 'inloop is not ready yet.' }
    const v = e.args.trim().toLowerCase()
    const s = await read($, settingsAtom)
    const isOn = v === '' ? !s.briefAgent : v === 'on' || v === 'true' || v === 'yes'
    await app.setSettings({ briefAgent: isOn })
    return { text: isOn ? "From the next request, the coding agent keeps its replies short while inloop explains changes (in auto mode)." : "The coding agent's replies are back to normal." }
  }).catch(() => ({ text: 'that command failed; see the inloop pane for details.' }))

}
