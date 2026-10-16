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
import { Repo, RepoError } from './repo'
import { parseVoices, pickVoice, type Voice } from './voices'
import { isNoise, isSensitive, toRelative } from './security'
import { DEFAULT_SETTINGS } from './state'

export const PANE = 'inloop'
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const MAX_CARDS = 80
const MAX_HISTORY = 150
const MAX_QUEUED_BATCHES = 3
const RECENT_KEEP_MS = 3 * 60 * 60 * 1000

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
    void this.refreshVoices()
    await this.refreshStatus()
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
  }

  /**
   * Whole-file before and after text for an edit: Write read the file before
   * it ran; Edit and MultiEdit are undone on the text after, in reverse. When
   * that cannot be done exactly, the edit's own snippets stand in.
   */
  private async toChange(edit: RawEdit): Promise<FileChange> {
    const after = await this.repo.read(edit.rel).catch(() => null)
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

  private async schedule(): Promise<void> {
    this.timer?.cancel()
    const due = this.batcher.dueAt()
    if (due !== null) {
      this.timer = this.host.after(Math.max(50, due - Date.now()), () => void this.flush('quiet'))
    }
    await this.refreshStatus()
  }

  /** Ends the current batch: the agent paused, finished a turn, or went quiet. */
  async flush(_reason: string): Promise<void> {
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

  async addCard(raw: InloopCard): Promise<void> {
    const card = await this.withSteps(raw)
    await this.host.state.cards.update(list => [card, ...list].slice(0, MAX_CARDS))
    // The newest explanation opens by itself, unless the person opened another one to read.
    const open = await this.host.state.expanded.get()
    if (open === null || open === this.autoOpened) {
      await this.host.state.expanded.update(() => card.id)
      this.autoOpened = card.id
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

  /** The installed voices, read once at start and again on request. */
  voices: Voice[] = []

  async refreshVoices(): Promise<Voice[]> {
    this.voices = parseVoices(await this.host.listVoices().catch(() => ''))
    return this.voices
  }

  /** The voice speech will use for a setting ('' = the best installed). */
  currentVoice(chosen: string): string | undefined {
    return pickVoice(this.voices, chosen)
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
  private voiceHandle: { stop: () => void } | null = null
  private control: 'none' | 'next' | 'prev' | 'pause' | 'stop' | 'skip' = 'none'
  private resume: (() => void) | null = null
  private autoOpened: string | null = null
  /** The person closed the pane themselves; inloop does not reopen it until they ask (/inloop). */
  isPaneClosedByPerson = false

  /** Queues a card to be read aloud, its code shown step by step. At most three wait; the oldest gives way. */
  async narrate(card: InloopCard, first = false): Promise<void> {
    if (first) {
      this.narrationQueue = [card, ...this.narrationQueue.filter(c => c.id !== card.id)]
      if (this.isNarrating) this.interrupt('skip')
    } else {
      this.narrationQueue.push(card)
      while (this.narrationQueue.length > 3) this.narrationQueue.shift()
    }
    await this.host.state.narration.update(n => (n === null ? n : { ...n, queued: this.narrationQueue.length }))
    if (!this.isNarrating) void this.runNarration()
  }

  private interrupt(control: 'next' | 'prev' | 'pause' | 'stop' | 'skip'): void {
    this.control = control
    this.voiceHandle?.stop()
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

  /** Speaks one piece; resolves when it ends or is cut off. */
  private async sayPiece(text: string): Promise<void> {
    const settings = await this.settings()
    const handle = this.host.say(text, this.currentVoice(settings.voice))
    this.voiceHandle = handle
    await handle.done.catch(() => undefined)
    this.voiceHandle = null
  }

  /** The latest control pressed; read through a call because handlers change it while speech is awaited. */
  private currentControl(): typeof this.control {
    return this.control
  }

  private async runNarration(): Promise<void> {
    this.isNarrating = true
    try {
      while (this.narrationQueue.length > 0) {
        const card = this.narrationQueue.shift()!
        const steps: InloopStep[] = card.steps !== undefined && card.steps.length > 0
          ? card.steps
          : [{ text: card.summary, ref: card.refs[0] ?? { path: card.files[0] ?? '' } }]
        this.control = 'none'
        // The code is shown as it is discussed: bring the pane back if it went away on its own,
        // but not if the person closed it (the band above the prompt stands in then).
        if (!this.isPaneClosedByPerson) void this.host.openPane().catch(() => undefined)
        await this.host.state.narration.update(() => ({ cardId: card.id, title: card.title, steps, index: -1, isPaused: false, queued: this.narrationQueue.length }))
        let i = -1
        while (i < steps.length) {
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
          const text = i < 0 ? `${card.title}.` : speakable(steps[i]!.text, 600)
          await this.sayPiece(text)
          const control = this.currentControl()
          if (control === 'stop' || control === 'skip') break
          if (control === 'pause') continue
          this.control = 'none'
          i = control === 'prev' ? Math.max(0, i - 1) : i + 1
        }
        if (this.currentControl() === 'stop') break
      }
    } finally {
      this.isNarrating = false
      this.control = 'none'
      this.voiceHandle = null
      await this.host.state.narration.update(() => null)
    }
  }

  async speak(text: string): Promise<void> {
    try {
      const settings = await this.settings()
      await this.host.speak(text, this.currentVoice(settings.voice))
    } catch (err) {
      await this.host.state.status.update(s => ({ ...s, lastError: `speech: ${String((err as Error).message ?? err)}` }))
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
  ask(question: string, kind: AskKind = 'question'): Promise<void> {
    const run = async (): Promise<void> => {
      const turn: InloopTurn = { role: 'you', text: question, at: Date.now() }
      await this.host.state.convo.update(c => [...c, turn].slice(-40))
      await this.setBusy(kind === 'flow' ? 'tracing the flow…' : 'investigating…')
      try {
        const env = await this.env(t => void this.host.state.status.update(s => ({ ...s, busy: t })))
        const result = await ask(env, question, kind)
        const reply: InloopTurn = { role: 'inloop', text: result.answer, at: Date.now(), refs: result.refs }
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
          title: question.length > 80 ? question.slice(0, 77) + '…' : question,
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
        await this.addCard(card)
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

  /** Goes to a tab, remembering the screen left behind so back returns to it. */
  async setTab(tab: InloopTab): Promise<void> {
    if ((await this.host.state.tab.get()) !== tab) await this.remember()
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
    if (isMove) await this.remember()
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

  /** Back to the previous screen: an explanation, a code location, a flow, a commit. */
  async back(): Promise<void> {
    const stack = await this.host.state.nav.get()
    const prev = stack.at(-1)
    if (prev === undefined) {
      if ((await this.host.state.tab.get()) !== 'feed') await this.showTab('feed')
      return
    }
    await this.host.state.nav.update(b => b.slice(0, -1))
    if (prev.viewer !== null) {
      await this.host.state.viewer.update(() => prev.viewer)
      await this.syncContext(prev.viewer)
    }
    await this.host.state.expanded.update(() => prev.expanded)
    await this.showTab(prev.tab)
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
    if (change.style === 'written') this.narrationStop()
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
