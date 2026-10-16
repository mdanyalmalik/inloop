// The controller: receives edits, batches them, decides what deserves an
// explanation, runs the bounded background work, and carries out what the
// person asks for from the pane or a command. It never writes to the project.

import type { Host } from './host'

import type {
  InloopCard,
  InloopContext,
  InloopFlow,
  InloopNav,
  InloopRef,
  InloopSettings,
  InloopStep,
  InloopTab,
  InloopFileChange,
  InloopTurn,
  InloopViewer,
} from '../types'
import { analyzeChange, type FileChange, matchesFocus } from './analysis'
import { Batcher, hash, Lru } from './batcher'
import {
  ask,
  type AskKind,
  type Batch,
  callerMap,
  compareRevs,
  diffBatch,
  type Env,
  explainCommit,
  explainLink,
  explainStep,
  captureStep,
  type Model,
  modelCard,
  speakable,
  staticCard,
  staticFlow,
} from './explain'
import { enclosingSymbol } from './graph'
import { summarizeDiff, unifiedDiff } from './diff'
import { Repo, RepoError } from './repo'
import { parseVoices, pickVoice, planVoice, type Voice, type VoicePlan } from './voices'
import { isNoise, isSensitive, toRelative } from './security'
import { DEFAULT_SETTINGS } from './state'

export const PANE = 'inloop'
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const MAX_CARDS = 80
const MAX_HISTORY = 150
const MAX_QUEUED_BATCHES = 3
const RECENT_KEEP_MS = 3 * 60 * 60 * 1000

/** Pieces of speech played in turn; each can be cut off. */
type Speaker = { play: (i: number) => Promise<void>; stopPiece: () => void; close: () => void }

type RawEdit = { tool: string; rel: string; input: Record<string, unknown>; before: string | null | undefined; at: number }
type RecentBatch = { at: number; batch: Batch }

export class App {
  repo!: Repo
  private batcher = new Batcher({ quietMs: 6000, maxWaitMs: 45_000, maxFiles: 12 })
  private timer: { cancel: () => void } | null = null
  private raw: RawEdit[] = []
  private queue: Batch[] = []
  private isWorking = false
  private askChain: Promise<void> = Promise.resolve()
  private seen = new Lru<true>(400)
  private cache = new Lru<string>(200)
  private recent: RecentBatch[] = []
  private counter = 0
  private aborter = new AbortController()

  constructor(readonly host: Host) {}

  async start(): Promise<void> {
    this.repo = await Repo.open(this.host)
    const stored = (await this.host.storeGet('settings')) as (Partial<InloopSettings> & { speak?: boolean }) | undefined
    // Settings saved before the written/spoken styles kept a speech on/off switch.
    const { speak: oldSpeak, ...kept } = stored ?? {}
    const settings: InloopSettings = { ...DEFAULT_SETTINGS, ...kept }
    if (kept.style === undefined && oldSpeak === true) settings.style = 'spoken'
    await this.host.state.settings.update(() => settings)
    this.batcher = new Batcher({ quietMs: settings.quietSeconds * 1000, maxWaitMs: 45_000, maxFiles: 12 })
    const history = (await this.host.storeGet('history')) as InloopCard[] | undefined
    if (Array.isArray(history)) await this.host.state.history.update(() => history)
    await this.snapshotBaseline().catch(() => undefined)
    this.detach(() => this.prepareVoice())
    await this.refreshStatus()
  }

  /** Set at session start: a -p or SDK run, where no one sees the pane. */
  isHeadless = false

  /**
   * Whether inloop is explaining changes where the person can see or hear
   * them right now; only then is the coding agent asked to keep replies short.
   */
  async isBriefActive(): Promise<boolean> {
    const settings = await this.settings()
    if (!settings.briefAgent || settings.mode !== 'auto' || this.isHeadless) return false
    if (settings.style === 'spoken') return true
    const panes = await this.host.panes().catch(() => [])
    return panes.some(p => p.id === PANE && p.isPlaced)
  }

  /** Explains what is batched and waits, at most `ms`, for queued work to finish. */
  async drain(ms: number): Promise<void> {
    await this.flush('ending')
    const until = Date.now() + ms
    while ((this.isWorking || this.queue.length > 0) && Date.now() < until) {
      await new Promise<void>(resolve => this.host.after(200, resolve))
    }
  }

  stop(): void {
    this.aborter.abort()
    this.timer?.cancel()
  }

  newId(): string {
    this.counter++
    return `${Date.now().toString(36)}${this.counter.toString(36)}`
  }

  private async settings(): Promise<InloopSettings> {
    return this.host.state.settings.get()
  }

  // ---- model calls, counted --------------------------------------------------

  readonly model: Model = async req => {
    const key = hash(`${req.model}\n${req.system}\n${req.prompt}`)
    const held = this.cache.get(key)
    if (held !== undefined) return held
    const r = await this.host.complete(
      { model: req.model, system: req.system, prompt: req.prompt, maxTokens: req.maxTokens ?? 1024, timeoutMs: 180_000 },
      { signal: req.signal ?? this.aborter.signal },
    )
    const usage = r.usage
    await this.host.state.usage.update(u => ({
      calls: u.calls + 1,
      inputTokens: u.inputTokens + (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0),
      outputTokens: u.outputTokens + (usage?.output_tokens ?? 0),
    }))
    if (!r.isAnswered) {
      const why = r.reason === 'api-error' ? `API error ${r.status ?? ''} ${r.error ?? ''}`.trim() : r.reason
      throw new Error(`model call failed: ${why}`)
    }
    this.cache.set(key, r.text)
    return r.text
  }

  private async env(progress?: (t: string) => void): Promise<Env> {
    return {
      repo: this.repo,
      model: this.model,
      settings: await this.settings(),
      ctx: await this.host.state.ctx.get(),
      convo: await this.host.state.convo.get(),
      now: Date.now(),
      newId: () => this.newId(),
      signal: this.aborter.signal,
      progress,
    }
  }

  // ---- status ------------------------------------------------------------------

  async setBusy(busy: string | null, error?: string): Promise<void> {
    await this.host.state.status.update(s => ({ ...s, busy, lastError: error ?? (busy === null ? s.lastError : undefined) }))
    await this.refreshStatus()
  }

  async dismissError(): Promise<void> {
    await this.host.state.status.update(s => ({ ...s, lastError: undefined }))
  }

  async refreshStatus(): Promise<void> {
    const now = Date.now()
    this.recent = this.recent.filter(r => now - r.at < RECENT_KEEP_MS)
    const status = await this.host.state.status.update(s => ({
      ...s,
      queued: this.queue.length,
      pendingChanges: this.batcher.size,
      recentBatches: this.recent.length,
    }))
    const settings = await this.settings()
    const cards = await this.host.state.cards.get()
    const mode = settings.mode === 'focus' ? `focus: ${settings.focus || '?'}` : settings.mode
    const parts = [mode]
    if (cards.length > 0) parts.push(`${cards.length} explained`)
    if (status.busy !== null) parts.push(status.busy)
    else if (status.pendingChanges > 0) parts.push('watching edits…')
    if (status.isPreparingAudio === true) parts.push('generating audio…')
    if (status.isVoiceSettingUp === true) parts.push('setting up the natural voice…')
    this.host.status(parts.join(' · '))
  }

  // ---- observing edits ---------------------------------------------------------

  /** Called after an edit tool succeeded; returns at once, the work runs on a timer. */
  recordEdit(tool: string, path: string, input: Record<string, unknown>, before: string | null | undefined): void {
    const rel = toRelative(this.repo.root, path)
    if (rel === null || isNoise(rel)) return
    this.repo.touch(rel)
    if (isSensitive(rel)) return
    this.raw.push({ tool, rel, input, before, at: Date.now() })
    this.host.after(0, () => void this.drainRaw())
  }

  private async drainRaw(): Promise<void> {
    const edits = this.raw.splice(0)
    for (const edit of edits) this.batcher.add(await this.toChange(edit))
    await this.schedule()
    if (edits.length > 0) await this.refreshTurnChanges()
  }

  // ---- changes since the last prompt -------------------------------------------

  /** Each file touched since the person's last prompt, with its text as it was then (null: it did not exist). */
  private turnStart = new Map<string, string | null>()

  /** The person sent a prompt: what changes from here is what the changes strip shows. */
  markPrompt(): void {
    this.turnStart.clear()
    const since = Date.now()
    this.detach(() => this.host.state.changes.update(() => ({ since, files: [] })))
  }

  /** Recomputes the net change of every file touched since the prompt, from its text then to its text now. */
  async refreshTurnChanges(): Promise<void> {
    const files: InloopFileChange[] = []
    for (const [path, start] of this.turnStart) {
      const now = await this.repo.readFresh(path)
      if (now === start) continue
      if ((start?.length ?? 0) > 400_000 || (now?.length ?? 0) > 400_000) {
        files.push({ path, added: 0, removed: 0, ranges: [], hunks: '' })
        continue
      }
      const hunks = unifiedDiff(start ?? '', now ?? '')
      if (hunks === '') continue
      const summary = summarizeDiff(`--- a/${path}\n+++ b/${path}\n${hunks}`)[0]
      if (summary === undefined) continue
      files.push({ ...summary, ...(start === null ? { isNew: true } : {}), ...(now === null ? { isDeleted: true } : {}) })
    }
    await this.host.state.changes.update(cur => ({ since: cur.since, files }))
  }

  /**
   * Whole-file before and after text for an edit: Write read the file before
   * it ran; Edit and MultiEdit are undone on the text after, in reverse. When
   * that cannot be done exactly, the edit's own snippets stand in.
   */
  private async toChange(edit: RawEdit): Promise<FileChange> {
    const prior = this.baseline.get(edit.rel)
    const change = await this.reconstruct(edit)
    if (!this.turnStart.has(edit.rel)) {
      const known = change.before ?? (edit.tool === 'Write' && edit.before === null ? null : undefined)
      this.turnStart.set(edit.rel, known !== undefined ? known : prior !== undefined ? prior : await this.repo.read(edit.rel, 'HEAD').catch(() => null))
    }
    return change
  }

  private async reconstruct(edit: RawEdit): Promise<FileChange> {
    const after = await this.repo.read(edit.rel).catch(() => null)
    if (after !== null) this.baseline.set(edit.rel, after)
    const base = { path: edit.rel, tools: [edit.tool], at: edit.at }
    if (edit.tool === 'Write') return { ...base, before: edit.before ?? null, after, snippets: [] }
    const pairs: { old: string; new: string; all: boolean }[] = []
    const collect = (o: Record<string, unknown>) => {
      if (typeof o.old_string === 'string' && typeof o.new_string === 'string') {
        pairs.push({ old: o.old_string, new: o.new_string, all: o.replace_all === true })
      } else if (typeof o.new_source === 'string') {
        pairs.push({ old: '', new: o.new_source, all: false })
      }
    }
    if (Array.isArray(edit.input.edits)) for (const one of edit.input.edits) collect(one as Record<string, unknown>)
    else collect(edit.input)
    const snippets = pairs.map(p => ({ old: p.old, new: p.new }))
    if (after === null || edit.tool === 'NotebookEdit') return { ...base, before: null, after: null, snippets }
    let before = after
    for (const p of [...pairs].reverse()) {
      if (p.new === '' || !before.includes(p.new)) return { ...base, before: null, after: null, snippets }
      before = p.all ? before.split(p.new).join(p.old) : before.replace(p.new, () => p.old)
    }
    return { ...base, before, after, snippets: [] }
  }

  // ---- changes made outside the edit tools ---------------------------------------

  /**
   * The last text inloop knows of each file that differs from HEAD. A change made
   * by a shell command or a script is what differs from it; what was already
   * uncommitted when the session started is the person's, never explained.
   */
  private baseline = new Map<string, string>()
  private isScanning = false
  private isScanAgain = false

  private async snapshotBaseline(): Promise<void> {
    for (const path of (await this.repo.dirtyFiles().catch(() => [] as string[])).slice(0, 300)) {
      const text = await this.repo.readFresh(path)
      if (text !== null && text.length <= 400_000) this.baseline.set(path, text)
    }
  }

  /** A shell command ran: look for files it changed, off the agent's time. Scans in a burst coalesce. */
  noteShell(): void {
    if (this.isScanning) {
      this.isScanAgain = true
      return
    }
    this.detach(() => this.scanWorkingTree())
  }

  /** Finds files changed since inloop last saw them, by any means, and batches them like edits. */
  async scanWorkingTree(): Promise<void> {
    if (!this.repo.isGit || this.repo.notProject !== null) return
    if (this.isScanning) {
      this.isScanAgain = true
      return
    }
    this.isScanning = true
    try {
      do {
        this.isScanAgain = false
        const dirty = await this.repo.dirtyFiles().catch(() => [] as string[])
        let isFound = false
        let isMoved = false
        for (const path of new Set([...dirty, ...this.baseline.keys()])) {
          // An edit tool is already reporting this one.
          if (this.raw.some(r => r.rel === path)) continue
          const now = await this.repo.readFresh(path)
          if (now === null) {
            // Deleted: the changes since the prompt show it gone.
            if (!this.turnStart.has(path) && this.baseline.has(path)) this.turnStart.set(path, this.baseline.get(path)!)
            if (this.baseline.delete(path)) isMoved = true
            continue
          }
          const known = this.baseline.has(path) ? this.baseline.get(path)! : await this.repo.read(path, 'HEAD').catch(() => null)
          if (now === known) continue
          this.baseline.set(path, now)
          if (!this.turnStart.has(path)) this.turnStart.set(path, known)
          isMoved = true
          if (now.length > 400_000) continue
          this.batcher.add({ path, before: known, after: now, snippets: [], tools: ['Bash'], at: Date.now() })
          isFound = true
        }
        if (isFound) await this.schedule()
        if (isMoved) await this.refreshTurnChanges()
      } while (this.isScanAgain)
    } finally {
      this.isScanning = false
    }
  }

  private async schedule(): Promise<void> {
    this.timer?.cancel()
    const due = this.batcher.dueAt()
    if (due !== null) {
      this.timer = this.host.after(Math.max(50, due - Date.now()), () => void this.flush('quiet'))
    }
    await this.refreshStatus()
  }

  /** Ends the current batch: the agent paused, finished a turn, or went quiet. */
  async flush(reason: string): Promise<void> {
    // At the end of a turn, catch what no edit tool or shell command reported (a subagent's script, a formatter).
    if (reason === 'turn' || reason === 'ending') await this.scanWorkingTree().catch(() => undefined)
    this.timer?.cancel()
    this.timer = null
    if (this.raw.length > 0) await this.drainRaw()
    const changes = this.batcher.take()
    if (changes.length === 0) return void (await this.refreshStatus())
    const analyses = changes.map(analyzeChange)
    const batch: Batch = { changes, analyses, diffs: diffBatch(changes) }
    if (batch.diffs.length === 0) return void (await this.refreshStatus())
    const key = hash(batch.diffs.map(d => d.path + d.hunks).join('\n'))
    if (this.seen.has(key)) return void (await this.refreshStatus())
    this.seen.set(key, true)
    this.recent.push({ at: Date.now(), batch })
    const settings = await this.settings()
    if (settings.mode === 'auto' || settings.mode === 'focus') {
      this.queue.push(batch)
      while (this.queue.length > MAX_QUEUED_BATCHES) {
        // Falling behind: fold the two oldest steps into one rather than drop either.
        const [a, b] = this.queue.splice(0, 2)
        this.queue.unshift(mergeBatches(a!, b!))
      }
      void this.work()
    }
    await this.refreshStatus()
  }

  private async work(): Promise<void> {
    if (this.isWorking) return
    this.isWorking = true
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.shift()!
        await this.refreshStatus()
        try {
          await this.explainBatch(batch, 'auto')
        } catch (err) {
          await this.host.state.status.update(s => ({ ...s, lastError: String((err as Error).message ?? err) }))
        }
      }
    } finally {
      this.isWorking = false
      await this.setBusy(null)
    }
  }

  /** Makes a card for a batch if it is significant (and on topic in focus mode). */
  async explainBatch(batch: Batch, source: InloopCard['source'], force = false, titlePrefix = ''): Promise<InloopCard | null> {
    const settings = await this.settings()
    const score = Math.max(...batch.analyses.map(a => a.score), 0) + Math.min(2, batch.analyses.length - 1)
    if (!force && score < settings.minScore) return null
    const diffText = batch.diffs.map(d => d.hunks).join('\n')
    const focus = settings.mode === 'focus' ? settings.focus.trim() : ''
    if (!force && focus !== '' && !matchesFocus(focus, batch.analyses, diffText)) {
      // Keywords did not settle it: one cheap classification, when models are on.
      if (settings.autoEngine !== 'model') return null
      const verdict = await this.host.classify(
        `Focus topic: ${focus}\nFiles: ${batch.analyses.map(a => a.path).join(', ')}\nChange:\n${diffText.slice(0, 3000)}`,
        ['related', 'unrelated'],
        { model: settings.autoModel },
      ).catch(() => 'unrelated')
      if (verdict !== 'related') return null
    }
    await this.setBusy('explaining a change…')
    const index = await this.repo.index().catch(() => null)
    const callers = index === null ? new Map<string, string[]>() : callerMap(index, batch.analyses)
    const base = staticCard(batch, callers, this.newId(), Date.now())
    base.source = source
    let card: InloopCard | null = base
    if (settings.autoEngine === 'model') {
      try {
        card = await modelCard(await this.env(), batch, base, focus, index ?? undefined)
      } catch (err) {
        card = { ...base, summary: `${base.summary}\n\n_(model explanation unavailable: ${String((err as Error).message ?? err)})_` }
      }
    }
    if (card === null) return null
    if (titlePrefix !== '') card = { ...card, title: `${titlePrefix}${card.title}` }
    await this.addCard(card)
    return card
  }

  async addCard(raw: InloopCard, options: { inFeed?: boolean } = {}): Promise<void> {
    const card = await this.withSteps(raw)
    if (options.inFeed !== false) {
      await this.host.state.cards.update(list => [card, ...list].slice(0, MAX_CARDS))
      // The newest explanation opens by itself, unless the person opened another one to read.
      const open = await this.host.state.expanded.get()
      if (open === null || open === this.autoOpened) {
        await this.host.state.expanded.update(() => card.id)
        this.autoOpened = card.id
      }
    }
    const slim: InloopCard = { ...card, diff: card.diff === undefined ? undefined : card.diff.slice(0, 6000) }
    const history = await this.host.state.history.update(list => [slim, ...list.filter(c => c.id !== card.id)].slice(0, MAX_HISTORY))
    await this.persistHistory(history)
    await this.refreshStatus()
    const settings = await this.settings()
    if (settings.style === 'spoken') void this.narrate(card)
    if (!(await this.isPaneShown())) {
      this.host.toast(`inloop: ${card.title}`, { timeoutMs: 5000 })
    }
  }

  private async persistHistory(history: readonly InloopCard[], removed: readonly string[] = []): Promise<void> {
    // Other sessions on this machine write the same store: merge, newest first.
    const stored = ((await this.host.storeGet('history').catch(() => undefined)) ?? []) as InloopCard[]
    const mine = new Map(history.map(c => [c.id, c]))
    const merged = [...history, ...(Array.isArray(stored) ? stored : []).filter(c => !mine.has(c.id) && !removed.includes(c.id))]
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_HISTORY)
    // The store holds 4 MiB in all.
    let keep = merged
    while (keep.length > 10 && JSON.stringify(keep).length > 2_500_000) keep = keep.slice(0, Math.floor(keep.length * 0.8))
    await this.host.storeSet('history', keep).catch(() => undefined)
  }

  async isPaneShown(): Promise<boolean> {
    const panes = await this.host.panes().catch(() => [])
    return panes.some(p => p.id === PANE && p.isPlaced)
  }

  /** The installed system voices, and whether Kokoro is set up; read at start and on request. */
  voices: Voice[] = []
  isKokoroReady = false

  async refreshVoices(): Promise<Voice[]> {
    this.voices = parseVoices(await this.host.listVoices().catch(() => ''))
    this.isKokoroReady = await this.host.kokoroReady().catch(() => false)
    return this.voices
  }

  /** The engine and voice a setting speaks with ('' = the best available: Kokoro once set up). */
  voicePlan(setting: string): VoicePlan {
    return planVoice(setting, this.isKokoroReady, this.voices)
  }

  private voiceSetup: Promise<string> | null = null

  /**
   * At start: finds the voices, and when the natural voice is missing, sets it up
   * in the background (a one-time download). The Mac's voice speaks meanwhile.
   */
  async prepareVoice(): Promise<void> {
    await this.refreshVoices()
    const settings = await this.settings()
    if (this.isKokoroReady || !settings.autoVoiceSetup || this.isHeadless || !this.host.hasUv) return
    const said = await this.setupKokoro()
    if (this.isKokoroReady) this.host.toast(`inloop: ${said}`, { timeoutMs: 6000 })
  }

  /** Installs Kokoro (one download), then makes it the voice. One setup at a time. */
  setupKokoro(): Promise<string> {
    if (this.voiceSetup !== null) return this.voiceSetup
    const run = async (): Promise<string> => {
      if (!this.host.hasUv) return 'The natural voice needs uv (https://docs.astral.sh/uv/). Until then inloop uses the Mac voice.'
      await this.host.state.status.update(s => ({ ...s, isVoiceSettingUp: true }))
      await this.refreshStatus()
      try {
        const result = await this.host.kokoroSetup()
        await this.refreshVoices()
        if (!this.isKokoroReady) return `The natural voice could not be set up: ${result.text.trim().split('\n').pop() ?? 'unknown error'}`
        return 'The natural voice (Kokoro) is ready and is now the voice.'
      } finally {
        await this.host.state.status.update(s => ({ ...s, isVoiceSettingUp: false }))
        await this.refreshStatus()
        this.voiceSetup = null
      }
    }
    this.voiceSetup = run()
    return this.voiceSetup
  }

  /**
   * Runs long work outside the event that asked for it (a button press, a
   * command), on a timer of the plugin's own: a press or command answers at
   * once, and no hook's time limit can cut the work, or its speech, short.
   */
  detach(work: () => Promise<unknown>): void {
    this.host.after(0, () => {
      void work().catch(err => this.host.state.status.update(st => ({ ...st, lastError: String((err as Error).message ?? err) })))
    })
  }

  /** A card's steps; a card that came without them (a commit, a comparison) gets one per reference. */
  private async withSteps(card: InloopCard): Promise<InloopCard> {
    if (card.steps !== undefined && card.steps.length > 0) return card
    const steps: InloopStep[] = []
    for (const ref of card.refs.slice(0, 5)) {
      if (ref.line === undefined) continue
      steps.push(await captureStep(this.repo, ref.label ?? `${ref.path}, line ${ref.line}`, { ...ref, label: undefined }))
    }
    return { ...card, steps }
  }

  // ---- narration -----------------------------------------------------------------

  private narrationQueue: InloopCard[] = []
  private isNarrating = false
  private speakerNow: Speaker | null = null
  private control: 'none' | 'next' | 'prev' | 'pause' | 'stop' | 'skip' = 'none'
  private resume: (() => void) | null = null
  private autoOpened: string | null = null
  /** The person closed the pane themselves; inloop does not reopen it until they ask (/inloop). */
  isPaneClosedByPerson = false

  /** Queues a card to be read aloud, its code shown part by part. At most three wait; the oldest gives way. */
  async narrate(card: InloopCard, first = false): Promise<void> {
    if (first) {
      this.narrationQueue = [card, ...this.narrationQueue.filter(c => c.id !== card.id)]
      if (this.isNarrating) this.interrupt('skip')
    } else {
      this.narrationQueue.push(card)
      while (this.narrationQueue.length > 3) this.narrationQueue.shift()
    }
    await this.host.state.narration.update(n => (n === null ? n : { ...n, queued: this.narrationQueue.length }))
    if (!this.isNarrating) {
      this.isNarrating = true
      this.detach(() => this.runNarration())
    }
  }

  private interrupt(control: 'next' | 'prev' | 'pause' | 'stop' | 'skip'): void {
    this.control = control
    this.speakerNow?.stopPiece()
    if (control !== 'pause') {
      this.resume?.()
      this.resume = null
    }
  }

  async narrationPause(): Promise<void> {
    if (!this.isNarrating) return
    this.interrupt('pause')
    await this.host.state.narration.update(n => (n === null ? n : { ...n, isPaused: true }))
  }

  async narrationResume(): Promise<void> {
    this.control = 'none'
    this.resume?.()
    this.resume = null
    await this.host.state.narration.update(n => (n === null ? n : { ...n, isPaused: false }))
  }

  narrationNext(): void {
    this.interrupt('next')
  }

  narrationPrev(): void {
    this.interrupt('prev')
  }

  narrationStop(): void {
    this.narrationQueue = []
    this.interrupt('stop')
  }

  /** The latest control pressed; read through a call because handlers change it while speech is awaited. */
  private currentControl(): typeof this.control {
    return this.control
  }

  /**
   * Speaks pieces of text in turn. Kokoro renders every piece ahead in one
   * process (so there is no gap between them) and each is played as a clip
   * that can be cut off; the system voice speaks each directly. A piece Kokoro
   * could not render falls back to the system voice.
   */
  private async speaker(texts: readonly string[], isInterrupted: () => boolean, onPreparing?: (isPreparing: boolean) => Promise<void>): Promise<Speaker> {
    const plan = this.voicePlan((await this.settings()).voice)
    const systemName = plan.engine === 'system' ? plan.name : pickVoice(this.voices, '')
    let current: { stop: () => void } | null = null
    let cancelWait: (() => void) | null = null
    const direct = async (text: string): Promise<void> => {
      const handle = this.host.say(text, systemName)
      current = handle
      await handle.done.catch(() => undefined)
      current = null
    }
    if (plan.engine === 'system') {
      return { play: i => direct(texts[i] ?? ''), stopPiece: () => current?.stop(), close: () => current?.stop() }
    }
    const synth = this.host.synthesize(texts, plan.id, 1.0)
    const ready: (string | null | undefined)[] = texts.map(() => undefined)
    const waiters = new Map<number, () => void>()
    void (async () => {
      let i = 0
      try {
        for await (const path of synth.paths) {
          ready[i] = path
          waiters.get(i)?.()
          i++
        }
      } catch {
        // Rendering failed: what is left falls back to the system voice.
      }
      for (let j = i; j < texts.length; j++) {
        ready[j] = null
        waiters.get(j)?.()
      }
    })()
    return {
      play: async i => {
        if (ready[i] === undefined) {
          // Rendering is behind (the first part, while the model loads): say so until it is ready.
          const rendered = new Promise<void>(resolve => {
            waiters.set(i, resolve)
            cancelWait = resolve
          })
          await this.preparingAudio(true, onPreparing)
          try {
            if (ready[i] === undefined) await rendered
          } finally {
            await this.preparingAudio(false, onPreparing)
          }
        }
        cancelWait = null
        if (isInterrupted()) return
        const path = ready[i]
        if (path === undefined) return
        if (path === null) return direct(texts[i] ?? '')
        const handle = this.host.play(path)
        current = handle
        await handle.done.catch(() => undefined)
        current = null
      },
      stopPiece: () => {
        current?.stop()
        cancelWait?.()
      },
      close: () => {
        current?.stop()
        cancelWait?.()
        synth.stop()
      },
    }
  }

  /** Shows that speech is being generated: on the part being read, and in the status line. */
  private async preparingAudio(isPreparing: boolean, onPreparing?: (isPreparing: boolean) => Promise<void>): Promise<void> {
    await this.host.state.status.update(s => ({ ...s, isPreparingAudio: isPreparing }))
    await onPreparing?.(isPreparing)
    await this.refreshStatus()
  }

  private async runNarration(): Promise<void> {
    this.isNarrating = true
    try {
      while (this.narrationQueue.length > 0) {
        const card = this.narrationQueue.shift()!
        // The explanation itself first (the answer, or the change's summary), then each part with its code.
        const lead: InloopStep = { text: card.summary, ref: { path: '' } }
        const steps: InloopStep[] = [lead, ...(card.steps ?? [])]
        this.control = 'none'
        this.oneOff?.close()
        // The code is shown as it is discussed: bring the pane back if it went away on its own,
        // but not if the person closed it (the band above the prompt stands in then).
        if (!this.isPaneClosedByPerson) void this.host.openPane().catch(() => undefined)
        await this.host.state.narration.update(() => ({ cardId: card.id, title: card.title, steps, index: 0, isPaused: false, queued: this.narrationQueue.length }))
        const speaker = await this.speaker(
          steps.map((st, i) => speakable(st.text, i === 0 ? 900 : 320)),
          () => this.currentControl() !== 'none',
          isPreparing => this.host.state.narration.update(n => (n === null ? n : { ...n, isPreparing })).then(() => undefined),
        )
        this.speakerNow = speaker
        try {
          let i = 0
          while (i < steps.length) {
            // Stopped (or the style switched to written) while the voice was getting ready: say nothing.
            if (this.currentControl() === 'stop' || this.currentControl() === 'skip') break
            if (this.currentControl() === 'pause') {
              await new Promise<void>(resolve => { this.resume = resolve })
              const after = this.currentControl()
              if (after !== 'none') {
                if (after === 'next' || after === 'prev') {
                  i = after === 'next' ? i + 1 : Math.max(0, i - 1)
                  this.control = 'none'
                  continue
                }
                break
              }
            }
            await this.host.state.narration.update(n => (n === null ? n : { ...n, index: i, isPaused: false }))
            await speaker.play(i)
            const control = this.currentControl()
            if (control === 'stop' || control === 'skip') break
            if (control === 'pause') continue
            this.control = 'none'
            i = control === 'prev' ? Math.max(0, i - 1) : i + 1
          }
        } finally {
          speaker.close()
          this.speakerNow = null
        }
        // A stop emptied the queue; whatever is queued now came after it and is read.
      }
    } finally {
      this.isNarrating = false
      this.control = 'none'
      this.speakerNow = null
      await this.host.state.narration.update(() => null)
    }
  }

  private oneOff: Speaker | null = null

  /**
   * Says one short thing (a voice test, a confirmation) with the chosen voice.
   * One voice at a time: it is skipped while an explanation is being read, and
   * an explanation starting cuts it off.
   */
  async speak(text: string): Promise<void> {
    if (this.isNarrating) return
    this.oneOff?.close()
    try {
      const speaker = await this.speaker([speakable(text, 400)], () => false)
      this.oneOff = speaker
      try {
        await speaker.play(0)
      } finally {
        speaker.close()
        if (this.oneOff === speaker) this.oneOff = null
      }
    } catch (err) {
      await this.host.state.status.update(st => ({ ...st, lastError: `speech: ${String((err as Error).message ?? err)}` }))
    }
  }

  // ---- recent changes ----------------------------------------------------------

  async explainRecent(minutes: number): Promise<InloopCard | null> {
    const since = Date.now() - minutes * 60_000
    const batches = this.recent.filter(r => r.at >= since).map(r => r.batch)
    if (this.batcher.size > 0) {
      await this.flush('asked')
      const last = this.recent.at(-1)
      if (last !== undefined && !batches.includes(last.batch)) batches.push(last.batch)
    }
    if (batches.length === 0) return null
    const merged = batches.reduce(mergeBatches)
    return this.explainBatch(merged, 'recent', true, `Last ${minutes} min: `)
  }

  // ---- questions -----------------------------------------------------------------

  /** Queues a question; answers land in the conversation, the feed and the viewer. */
  /**
   * Queues a question; the answer lands in the Ask tab (and the history), never
   * in the feed of changes. `label` is what the conversation shows for a
   * question a button asked.
   */
  ask(question: string, kind: AskKind = 'question', label?: string): Promise<void> {
    const run = async (): Promise<void> => {
      const turn: InloopTurn = { role: 'you', text: question, at: Date.now(), label }
      await this.host.state.askOpen.update(() => null)
      await this.host.state.convo.update(c => [...c, turn].slice(-40))
      await this.setBusy(kind === 'flow' ? 'tracing the flow…' : 'investigating…')
      try {
        const env = await this.env(t => void this.host.state.status.update(s => ({ ...s, busy: t })))
        const result = await ask(env, question, kind)
        const reply: InloopTurn = { role: 'inloop', text: result.answer, at: Date.now(), refs: result.refs, steps: result.steps }
        await this.host.state.convo.update(c => [...c, reply].slice(-40))
        if (result.scope !== undefined) await this.host.state.ctx.update(c => ({ ...c, scope: result.scope === '' ? undefined : result.scope }))
        if (result.rev !== env.ctx.rev) await this.host.state.ctx.update(c => ({ ...c, rev: result.rev, revLabel: result.revLabel }))
        let flowId: string | undefined
        if (result.flow !== null) {
          await this.showFlow(result.flow, false)
          flowId = result.flow.id
        }
        const card: InloopCard = {
          id: this.newId(),
          at: Date.now(),
          title: (() => {
            const title = label ?? question
            return title.length > 80 ? title.slice(0, 77) + '…' : title
          })(),
          summary: result.answer,
          files: [...new Set(result.refs.map(r => r.path))],
          symbols: [],
          refs: result.refs,
          steps: result.steps,
          rev: result.rev,
          source: kind === 'flow' ? 'flow' : 'ask',
          question,
          flowId,
        }
        await this.addCard(card, { inFeed: false })
        const first = result.refs[0]
        if (first !== undefined) await this.openRef(first, { switchTab: false })
        if (!(await this.isPaneShown())) this.host.log(`inloop — ${question}\n\n${result.answer}`)
      } catch (err) {
        const msg = err instanceof RepoError ? err.message : String((err as Error).message ?? err)
        await this.host.state.convo.update(c => [...c, { role: 'inloop' as const, text: `Could not answer: ${msg}`, at: Date.now() }])
        await this.setBusy(null, msg)
      } finally {
        await this.setBusy(null)
      }
    }
    this.askChain = this.askChain.then(run, run)
    return this.askChain
  }

  /** Reads an answer aloud, its parts with their code. */
  async listenTo(q: InloopTurn, a: InloopTurn): Promise<void> {
    await this.narrate({
      id: `answer:${a.at}`,
      at: a.at,
      title: q.label ?? q.text,
      summary: a.text,
      files: [],
      symbols: [],
      refs: a.refs ?? [],
      steps: a.steps,
      source: 'ask',
    }, true)
  }

  /** "Simpler" and "more detail": the previous answer again, titled after the question it answered. */
  async followUp(kind: 'simpler' | 'detail'): Promise<void> {
    const convo = await this.host.state.convo.get()
    const last = [...convo].reverse().find(t => t.role === 'you')
    if (last === undefined) return
    const topic = (last.label ?? last.text).replace(/^(simpler|more detail): /, '')
    const prompt = kind === 'simpler'
      ? 'Explain your previous answer again, more simply: plain words, at most four short sentences.'
      : "Explain your previous answer again with the full technical detail. Don't simplify."
    await this.ask(prompt, 'question', `${kind === 'simpler' ? 'simpler' : 'more detail'}: ${topic}`)
  }

  async explainCommit(rev: string): Promise<InloopCard | null> {
    await this.setBusy(`explaining commit ${rev.slice(0, 8)}…`)
    try {
      const card = await explainCommit(await this.env(), rev)
      await this.addCard(card)
      await this.host.state.expanded.update(() => card.id)
      if (!(await this.isPaneShown())) this.host.log(`inloop — ${card.title}\n\n${card.summary}`)
      return card
    } catch (err) {
      await this.setBusy(null, String((err as Error).message ?? err))
      return null
    } finally {
      await this.setBusy(null)
    }
  }

  async compare(from: string, to: string, topic: string): Promise<InloopCard | null> {
    await this.setBusy('comparing revisions…')
    try {
      const card = await compareRevs(await this.env(), from, to, topic)
      await this.addCard(card)
      await this.host.state.expanded.update(() => card.id)
      if (!(await this.isPaneShown())) this.host.log(`inloop — ${card.title}\n\n${card.summary}`)
      return card
    } catch (err) {
      await this.setBusy(null, String((err as Error).message ?? err))
      return null
    } finally {
      await this.setBusy(null)
    }
  }

  // ---- navigation ------------------------------------------------------------

  /** Goes to a tab. Tabs are independent: each keeps its own state, and switching records no history. */
  async setTab(tab: InloopTab): Promise<void> {
    await this.showTab(tab)
  }

  private async showTab(tab: InloopTab): Promise<void> {
    await this.host.state.tab.update(() => tab)
    if (tab === 'git' && this.repo.isGit) {
      const git = await this.host.state.git.get()
      if (git.commits.length === 0 && git.query === '') await this.gitSearch('')
    }
  }

  /** Pushes the current screen onto the back history (skipping a repeat). */
  private async remember(): Promise<void> {
    const here: InloopNav = {
      tab: await this.host.state.tab.get(),
      viewer: await this.host.state.viewer.get(),
      expanded: await this.host.state.expanded.get(),
    }
    await this.host.state.nav.update(stack => {
      const last = stack.at(-1)
      const same = last !== undefined && last.tab === here.tab && last.expanded === here.expanded &&
        last.viewer?.path === here.viewer?.path && last.viewer?.line === here.viewer?.line && last.viewer?.diff === here.viewer?.diff
      return same ? stack : [...stack, here].slice(-40)
    })
  }

  /**
   * Opens code in the viewer. With `switchTab` (the default) it is a move the
   * person makes: the screen left behind goes on the back history. Without, the
   * viewer is only primed for later (an answer's first reference).
   */
  async openRef(ref: InloopRef, options: { switchTab?: boolean; diff?: string; note?: string } = {}): Promise<void> {
    let rel: string
    try {
      rel = this.repo.rel(ref.path)
    } catch (err) {
      await this.setBusy(null, String((err as Error).message))
      return
    }
    const isMove = options.switchTab !== false
    // Within the Code tab, following code from one place to another can be stepped back.
    if (isMove && (await this.host.state.tab.get()) === 'code') await this.remember()
    const line = ref.line ?? 1
    const endLine = ref.endLine ?? line
    const viewer: InloopViewer = { path: rel, rev: ref.rev, line, endLine, top: Math.max(1, line - 4), diff: options.diff, note: options.note ?? ref.label }
    await this.host.state.viewer.update(() => viewer)
    await this.syncContext(viewer, ref.symbol)
    if (isMove) await this.showTab('code')
  }

  /** Questions are about what is on screen: its file, lines, symbol and revision. */
  private async syncContext(viewer: InloopViewer, known?: string): Promise<void> {
    let symbol = known
    if (symbol === undefined && viewer.diff === undefined) {
      const index = await this.repo.index(viewer.rev).catch(() => null)
      symbol = index === null ? undefined : enclosingSymbol(index, viewer.path, viewer.line)?.name
    }
    await this.host.state.ctx.update(c => ({
      ...c,
      path: viewer.path,
      line: viewer.line,
      endLine: viewer.endLine,
      symbol,
      rev: viewer.rev,
      revLabel: viewer.rev === undefined ? undefined : viewer.rev === c.rev ? c.revLabel : `commit ${viewer.rev.slice(0, 8)}`,
    }))
  }

  /** The Code tab's previous location: where you were before following a caller, callee or symbol. */
  async back(): Promise<void> {
    const stack = await this.host.state.nav.get()
    const prev = stack.at(-1)
    if (prev === undefined) return
    await this.host.state.nav.update(b => b.slice(0, -1))
    if (prev.viewer !== null) {
      await this.host.state.viewer.update(() => prev.viewer)
      await this.syncContext(prev.viewer)
    }
  }

  /** Scrolls the code viewer, stopping once the file's last line is in the window of `windowRows`. */
  async scroll(delta: number, windowRows = 10): Promise<void> {
    const v = await this.host.state.viewer.get()
    if (v === null) return
    const length = await this.repo.read(v.path, v.rev).then(t => t.split('\n').length, () => v.top + delta)
    const top = Math.min(Math.max(1, v.top + delta), Math.max(1, length - windowRows + 1))
    await this.host.state.viewer.update(cur => (cur === null ? cur : { ...cur, top }))
  }

  async selectLines(line: number, endLine: number): Promise<void> {
    const v = await this.host.state.viewer.get()
    if (v === null) return
    const next = { ...v, line, endLine, top: Math.max(1, line - 3), diff: undefined }
    // A jump within the file is a place to come back to.
    if (v.line !== line) await this.remember()
    await this.host.state.viewer.update(() => next)
    await this.syncContext(next)
  }

  async showFlow(flow: InloopFlow, switchTab = true): Promise<void> {
    await this.host.state.flow.update(() => flow)
    await this.host.state.flowSelected.update(() => null)
    await this.host.state.flowNote.update(() => null)
    await this.host.state.ctx.update(c => ({ ...c, flowId: flow.id }))
    if (switchTab) await this.setTab('flow')
  }

  /** A flow from static analysis alone (no model), for /inloop-flow when models are off or as a first draw. */
  async quickFlow(query: string): Promise<InloopFlow | null> {
    const ctx = await this.host.state.ctx.get()
    return staticFlow(this.repo, query, ctx.rev, this.newId(), Date.now())
  }

  async selectNode(nodeId: string): Promise<void> {
    const flow = await this.host.state.flow.get()
    if (flow === null) return
    const node = flow.nodes.find(n => n.id === nodeId)
    if (node === undefined) return
    await this.host.state.flowSelected.update(() => nodeId)
    await this.host.state.flowNote.update(() => 'Reading this step…')
    if (node.ref !== undefined) await this.openRef(node.ref, { switchTab: false })
    try {
      const note = await explainStep(await this.env(), flow, nodeId)
      if ((await this.host.state.flowSelected.get()) === nodeId) await this.host.state.flowNote.update(() => note)
    } catch (err) {
      await this.host.state.flowNote.update(() => `Could not explain this step: ${String((err as Error).message ?? err)}`)
    }
  }

  async explainEdge(index: number): Promise<void> {
    const flow = await this.host.state.flow.get()
    const edge = flow?.edges[index]
    if (flow === null || edge === undefined) return
    await this.host.state.flowNote.update(() => 'Reading this link…')
    try {
      const note = await explainLink(await this.env(), flow, edge)
      await this.host.state.flowNote.update(() => note)
    } catch (err) {
      await this.host.state.flowNote.update(() => `Could not explain this link: ${String((err as Error).message ?? err)}`)
    }
  }

  // ---- git -------------------------------------------------------------------

  async gitSearch(query: string): Promise<void> {
    try {
      const commits = await this.repo.log({ query: query.trim() || undefined, limit: 30 })
      await this.host.state.git.update(g => ({ ...g, query, commits, error: undefined }))
    } catch (err) {
      await this.host.state.git.update(g => ({ ...g, query, commits: [], error: String((err as Error).message ?? err) }))
    }
  }

  async gitSelect(sha: string): Promise<void> {
    try {
      const files = await this.repo.commitFiles(sha)
      await this.host.state.git.update(g => ({ ...g, selected: sha, files, error: undefined }))
    } catch (err) {
      await this.host.state.git.update(g => ({ ...g, error: String((err as Error).message ?? err) }))
    }
  }

  async openCommitFile(sha: string, path: string, asDiff: boolean): Promise<void> {
    try {
      if (asDiff) {
        const patch = await this.repo.commitPatch(sha, path)
        const hunks = patch.split('\n').filter(l => !/^(diff --git|index |similarity|rename |new file|deleted file|old mode|new mode)/.test(l)).join('\n')
        await this.openRef({ path, line: 1, rev: sha }, { diff: hunks, note: `diff of ${path} in ${sha.slice(0, 8)}` })
      } else {
        await this.openRef({ path, line: 1, rev: sha })
      }
    } catch (err) {
      await this.setBusy(null, String((err as Error).message ?? err))
    }
  }

  /** Sets the revision questions and the viewer read: a sha, a date, or the working tree. */
  async studyRevision(spec: string): Promise<string> {
    const s = spec.trim()
    if (s === '' || s === 'working' || s === 'now' || s === 'current') {
      await this.host.state.ctx.update(c => ({ ...c, rev: undefined, revLabel: undefined }))
      return 'Back to the working tree.'
    }
    let sha: string
    let label: string
    try {
      sha = await this.repo.resolve(s)
      const meta = await this.repo.commitMeta(sha)
      label = `${meta.short} (${meta.date.slice(0, 10)}) "${meta.subject}"`
    } catch {
      const at = await this.repo.revAt(s)
      sha = at.sha
      label = at.note
    }
    await this.host.state.ctx.update(c => ({ ...c, rev: sha, revLabel: label }))
    return `Now studying ${label}. Questions and the code viewer read this revision; your checkout is untouched.`
  }

  // ---- settings & history -------------------------------------------------------

  async setSettings(change: Partial<InloopSettings>): Promise<InloopSettings> {
    const next = await this.host.state.settings.update(s => ({ ...s, ...change }))
    await this.host.storeSet('settings', next)
    if (change.quietSeconds !== undefined) {
      const held = this.batcher.take()
      this.batcher = new Batcher({ quietMs: next.quietSeconds * 1000, maxWaitMs: 45_000, maxFiles: 12 })
      for (const c of held) this.batcher.add(c)
    }
    if (change.mode === 'paused' || change.mode === 'ask') this.queue.length = 0
    if (change.style === 'written') {
      this.narrationStop()
      this.oneOff?.close()
      this.oneOff = null
    }
    await this.refreshStatus()
    return next
  }

  async toggleBookmark(id: string): Promise<void> {
    const flip = (list: InloopCard[]) => list.map(c => (c.id === id ? { ...c, bookmarked: c.bookmarked !== true } : c))
    await this.host.state.cards.update(flip)
    const history = await this.host.state.history.update(list => {
      if (list.some(c => c.id === id)) return flip(list)
      return list
    })
    await this.persistHistory(history)
  }

  async clearHistory(keepBookmarks: boolean): Promise<void> {
    const stored = ((await this.host.storeGet('history').catch(() => undefined)) ?? []) as InloopCard[]
    const all = [...(await this.host.state.history.get()), ...(Array.isArray(stored) ? stored : [])]
    const history = await this.host.state.history.update(list => (keepBookmarks ? list.filter(c => c.bookmarked === true) : []))
    const kept = new Set(history.map(c => c.id))
    await this.persistHistory(history, all.filter(c => !kept.has(c.id)).map(c => c.id))
  }

  async clearScope(): Promise<void> {
    await this.host.state.ctx.update((c: InloopContext) => ({ ...c, scope: undefined }))
  }

  async setScope(scope: string): Promise<void> {
    await this.host.state.ctx.update((c: InloopContext) => ({ ...c, scope: scope.trim() || undefined }))
  }
}

export function mergeBatches(a: Batch, b: Batch): Batch {
  const byPath = new Map<string, FileChange>()
  for (const c of [...a.changes, ...b.changes]) {
    const held = byPath.get(c.path)
    if (held === undefined) byPath.set(c.path, { ...c, snippets: [...c.snippets], tools: [...c.tools] })
    else {
      held.after = c.after
      held.snippets.push(...c.snippets)
      held.at = c.at
    }
  }
  const changes = [...byPath.values()]
  return { changes, analyses: changes.map(analyzeChange), diffs: diffBatch(changes) }
}
