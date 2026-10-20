// The controller: receives edits, batches them, decides what deserves an
// explanation, runs the bounded background work, and carries out what the
// person asks for from the pane or a command. It never writes to the project.

import type { Host } from './host'

import type {
  InloopCard,
  InloopContext,
  InloopExchange,
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
import { Batcher, hash, Lru, mergeChange } from './batcher'
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
  parseReply,
  speakable,
  staticCard,
  staticFlow,
  turnSummary,
} from './explain'
import { enclosingSymbol } from './graph'
import { summarizeDiff, unifiedDiff } from './diff'
import { Repo, RepoError } from './repo'
import { nextRate, parseVoices, pickVoice, planVoice, type Voice, type VoicePlan } from './voices'
import { isNoise, isSensitive, toRelative } from './security'
import { DEFAULT_SETTINGS } from './state'

export const PANE = 'inloop'
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const MAX_CARDS = 80
const MAX_HISTORY = 150
const MAX_QUEUED_BATCHES = 3
/** How long a step stays recent: what the feed's "explain recent" counts and explains. */
export const RECENT_MINUTES = 180
const RECENT_KEEP_MS = RECENT_MINUTES * 60_000
const SPIN_MS = 120
/** Explanations whose audio is kept made at once (waiting, being read, kept to replay); the rest wait as text. */
const AUDIO_MAX = 5
/** How long audio made ahead is trusted: the voice script deletes clips an hour old, so older audio is made again before it plays. */
const AUDIO_KEEP_MS = 45 * 60_000
/** Explanations waiting to be read; past this a new one is written in the feed only. */
const NARRATION_MAX = 20
/** Waits before each retry of a model call that failed in passing: about a minute in all. */
const RETRY_WAITS_MS = [2000, 5000, 12_000, 30_000]
const NO_PLAYER = 'The natural voice needs an audio player, and none was found (on Linux: pipewire, pulseaudio-utils, alsa-utils or ffmpeg). Until then inloop uses the system voice.'

/** Pieces of speech played in turn; each can be cut off. */
/** Reads one explanation's parts; `rendered` settles once all its audio is made (at once for the system voice). */
type Speaker = { play: (i: number) => Promise<void>; stopPiece: () => void; close: () => void; rendered: Promise<void> }
/** An explanation waiting to be read; its speaker is made ahead, for a few at a time. */
/** `isStale`: its audio was made long enough ago that its clips may be gone. */
type Queued = { card: InloopCard; steps: InloopStep[]; speaker: Promise<Speaker> | null; isRendered: boolean; isAsked: boolean; isAway: boolean; isStale?: boolean }

/** Where an answer is shown: the Ask tab's conversation, or the tab (or explanation) that asked. */
export type AskPlace = 'ask' | 'code' | 'flow' | { card: string }

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
  private cache = new Lru<string>(200)
  private recent: RecentBatch[] = []
  private counter = 0
  private aborter = new AbortController()

  constructor(readonly host: Host) {}

  async start(): Promise<void> {
    this.repo = await Repo.open(this.host)
    const settings = await this.ensureState()
    this.batcher = new Batcher({ quietMs: settings.quietSeconds * 1000, maxWaitMs: 45_000, maxFiles: 12 })
    await this.snapshotBaseline().catch(() => undefined)
    this.detach(() => this.prepareVoice())
    await this.refreshStatus()
  }

  /**
   * Puts the saved settings, history and this project's earlier explanations into
   * the session's state. A new conversation after /clear or a resume starts with
   * fresh state and no session.start, so this runs again then (and before each
   * prompt): loading is the same each time, and only an empty feed or history is filled.
   */
  async ensureState(): Promise<InloopSettings> {
    const stored = (await this.host.storeGet('settings').catch(() => undefined)) as (Partial<InloopSettings> & { speak?: boolean }) | undefined
    // Settings saved before the written/spoken styles kept a speech on/off switch.
    const { speak: oldSpeak, ...kept } = stored ?? {}
    const settings: InloopSettings = { ...DEFAULT_SETTINGS, ...kept }
    if (kept.style === undefined && oldSpeak === true) settings.style = 'spoken'
    await this.host.state.settings.update(() => settings)
    this.isAway = isAwayOn(settings)
    const history = (await this.host.storeGet('history').catch(() => undefined)) as InloopCard[] | undefined
    if (Array.isArray(history) && history.length > 0) {
      if ((await this.host.state.history.get()).length === 0) await this.host.state.history.update(() => history)
      // The feed picks up where this project's last session left off.
      if ((await this.host.state.cards.get()).length === 0) {
        const earlier = await this.ownEarlier(history).catch(() => [] as InloopCard[])
        if (earlier.length > 0) await this.host.state.cards.update(list => [...list, ...earlier.filter(c => !list.some(x => x.id === c.id))].slice(0, MAX_CARDS))
      }
    }
    return settings
  }

  /** When this conversation started (a /clear starts a new one): the feed marks explanations from before it. */
  startedAt = Date.now()

  /**
   * This project's explanations from earlier sessions, newest first: those
   * tagged with its folder. An untagged one is never guessed in: another
   * project with the same file names (a copy, a clone, a demo) would pass.
   */
  private async ownEarlier(history: readonly InloopCard[]): Promise<InloopCard[]> {
    if (this.repo.notProject !== null) return []
    const out: InloopCard[] = []
    for (const card of history) {
      if (out.length >= 20) break
      if (card.source === 'ask' || card.at >= this.startedAt) continue
      if (card.root === this.repo.root) out.push(card)
    }
    return out
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
    this.animate(false)
    this.clearQueue()
    this.interrupt('stop')
    this.release()
  }

  /**
   * A conversation ended. After /clear or a resume the process goes on under a
   * new session and no session.start comes, so inloop must not stay stopped:
   * what was in flight is cut off (its line says so, with "try again"), and
   * watching goes on. Changes already noticed are still explained.
   */
  restart(): void {
    // What was waiting to be read still is (its audio is made again).
    const waiting = this.narrationQueue.filter(e => !e.isAsked).map(e => ({ ...e, speaker: null, isRendered: false }))
    this.stop()
    this.aborter = new AbortController()
    this.isClosing = false
    this.startedAt = Date.now()
    this.detach(async () => {
      await this.ensureState().catch(() => undefined)
      this.narrationQueue = [...waiting, ...this.narrationQueue]
      this.prerender()
      this.startNarration()
      await this.schedule()
      if (this.queue.length > 0) void this.work()
    })
  }

  /**
   * /inloop-reload: starts watching over as if just opened, without losing what
   * it knows. A scan or explanation that hung is let go, cached file text is
   * dropped, and the project is looked at again at once, so anything changed
   * since inloop last looked is explained now.
   */
  async reload(): Promise<string> {
    this.restart()
    this.scan = null
    this.isScanAgain = false
    this.isWorking = false
    this.repo.forget()
    await this.scanWorkingTree().catch(() => undefined)
    if (this.raw.length > 0) await this.drainRaw()
    await this.flush('asked')
    await this.refreshVoices().catch(() => undefined)
    const status = await this.host.state.status.get()
    if (this.repo.notProject !== null) return `inloop restarted, but ${this.repo.notProject}`
    const where = this.repo.isGit ? '' : ' (no git here, so only changes made with the edit tools are seen)'
    const waiting = status.queued + this.batcher.size
    return `inloop restarted${where}. ${waiting > 0 ? `${waiting} change${waiting === 1 ? '' : 's'} being explained now.` : 'Nothing new to explain since it last looked.'}`
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
    const call = () => this.host.complete(
      { model: req.model, system: req.system, prompt: req.prompt, maxTokens: req.maxTokens ?? 4000, ...(req.effort !== undefined ? { effort: req.effort } : {}), timeoutMs: 180_000 },
      { signal: req.signal ?? this.aborter.signal },
    )
    const signal = req.signal ?? this.aborter.signal
    // As Claude Code does for its own requests: a busy or briefly unreachable API is waited out, not reported.
    let r = await call()
    for (const wait of RETRY_WAITS_MS) {
      if (r.isAnswered || signal.aborted || !isPassing(r)) break
      await this.countUsage(r.usage)
      await new Promise<void>(resolve => this.host.after(wait, resolve))
      if (signal.aborted) break
      r = await call()
    }
    await this.countUsage(r.usage)
    if (!r.isAnswered) {
      const why = r.reason === 'api-error' ? `API error ${r.status ?? ''} ${r.error ?? ''}`.trim() : r.reason
      throw new Error(`model call failed: ${why}`)
    }
    // A reply cut off mid-JSON is never served again: "try again" asks anew.
    if (!parseReply(r.text).isCutOff) this.cache.set(key, r.text)
    return r.text
  }

  private async countUsage(usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | undefined): Promise<void> {
    await this.host.state.usage.update(u => ({
      calls: u.calls + 1,
      inputTokens: u.inputTokens + (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0),
      outputTokens: u.outputTokens + (usage?.output_tokens ?? 0),
    }))
  }

  private async env(progress?: (t: string) => void, isInConvo = true): Promise<Env> {
    const settings = await this.settings()
    return {
      repo: this.repo,
      model: this.model,
      investigate: settings.useReader ? this.host.investigate : undefined,
      settings,
      ctx: await this.host.state.ctx.get(),
      // A question asked outside the Ask tab stands alone: the Ask conversation is no context for it.
      convo: isInConvo ? await this.host.state.convo.get() : [],
      now: Date.now(),
      newId: () => this.newId(),
      signal: this.aborter.signal,
      progress,
    }
  }

  // ---- status ------------------------------------------------------------------

  /** Work under way, by when it started: the busy line names the newest, and clears only when none is left. */
  private busyJobs = new Map<number, string>()
  private busyCount = 0

  /** Runs work with a line saying what is under way; `progress` changes what the line says. */
  private async whileBusy<T>(label: string, work: (progress: (text: string) => void) => Promise<T>): Promise<T> {
    const job = ++this.busyCount
    const show = async (text: string | null, isStart = false): Promise<void> => {
      if (text === null) this.busyJobs.delete(job)
      else this.busyJobs.set(job, text)
      const busy = [...this.busyJobs.values()].at(-1) ?? null
      await this.host.state.status.update(s => ({ ...s, busy, lastError: isStart ? undefined : s.lastError }))
      await this.refreshStatus()
    }
    await show(label, true)
    try {
      return await work(text => void (this.busyJobs.has(job) ? show(text) : undefined))
    } finally {
      await show(null)
    }
  }

  /** Says what went wrong, under the tabs, until dismissed or the next work starts. */
  async report(error: string): Promise<void> {
    await this.host.state.status.update(s => ({ ...s, lastError: error }))
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
      waiting: this.narrationQueue.length,
      voiced: this.narrationQueue.filter(e => e.isRendered).length,
    }))
    const settings = await this.settings()
    const cards = await this.host.state.cards.get()
    const mode = settings.mode === 'focus' ? `focus: ${settings.focus || '?'}` : settings.mode
    const parts = [mode]
    if (this.isAway) parts.push(`away · ${this.narrationQueue.length} waiting`)
    if (cards.length > 0) parts.push(`${cards.length} explained`)
    if (status.busy !== null) parts.push(status.busy)
    else if (status.pendingChanges > 0) parts.push('watching edits…')
    if (status.isPreparingAudio === true) parts.push('generating audio…')
    if (status.isVoiceSettingUp === true) parts.push('setting up the natural voice…')
    this.host.status(parts.join(' · '))
    this.animate(status.busy !== null || status.isPreparingAudio === true || status.isVoiceSettingUp === true)
  }

  private spinner: { cancel: () => void } | null = null

  /** Turns the spinners on while something is being generated, and off after: no redraws while idle. */
  private animate(isOn: boolean): void {
    if (isOn && this.spinner === null) {
      this.spinner = this.host.every(SPIN_MS, () => void this.host.state.frame.update(n => (n + 1) % 1000))
    } else if (!isOn && this.spinner !== null) {
      this.spinner.cancel()
      this.spinner = null
    }
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
    // Edits that land together (parallel tool calls) are all in the file by now: each file's are undone as one.
    const byPath = new Map<string, RawEdit[]>()
    for (const edit of edits) byPath.set(edit.rel, [...(byPath.get(edit.rel) ?? []), edit])
    for (const group of byPath.values()) this.batcher.add(await this.toChange(group))
    await this.schedule()
    if (edits.length > 0) await this.refreshTurnChanges()
  }

  // ---- changes since the last prompt -------------------------------------------

  /** Each file touched since the person's last prompt, with its text as it was then (null: it did not exist). */
  private turnStart = new Map<string, string | null>()

  /**
   * What the person asked for, and since when; the turn summary leaves out what it
   * already says. `from` names how a turn began that the person did not start.
   */
  private request: { text: string; since: number; from?: string } = { text: '', since: 0 }

  /** A turn began without the person (a background task, a scheduled prompt): nothing in it is theirs already. */
  markOtherStart(from: string): void {
    this.request = { text: '', since: Date.now(), from }
    this.turnKey = this.newId()
    this.asked = `from ${from}`
  }

  /** The turn explanations are written in now; its cards sit under a line or summary only once it ends. */
  get currentTurn(): string {
    return this.turnKey
  }

  /** The line over the current turn's cards: its request's first words, or how it began. */
  private asked = ''

  /** The turn explanations are written in now ('' before the first prompt), the key that groups them under its summary. */
  private turnKey = ''

  /** The person sent a prompt: what changes from here is what the changes strip shows. */
  markPrompt(text = ''): void {
    this.turnStart.clear()
    const since = Date.now()
    this.request = { text, since }
    this.turnKey = this.newId()
    const line = text.trim().replace(/\s+/g, ' ')
    this.asked = line.length > 70 ? `${line.slice(0, 69)}…` : line
    this.detach(() => this.host.state.changes.update(() => ({ since, files: [] })))
    // What changed since the agent's turn ended is the person's own work: learned, never explained.
    this.detach(() => this.scanWorkingTree(true))
  }

  /** Where the last turn summary left off: a turn continued without a new prompt is summarised from there. */
  private summarizedTo = 0

  /**
   * The agent's turn ended: once its steps are explained, the turn's cards are
   * grouped, and one card says what the turn did that the request did not
   * already say, with the choices the agent made on its own. After a turn of one
   * step, whose explanation already says what changed, it holds only those
   * choices, and is left out when there were none. Auto mode, models on.
   */
  summarizeTurn(answer: string): Promise<void> {
    // One at a time: turns ending close together never summarise the same steps twice.
    const run = this.summaries.then(() => this.writeTurnSummary(answer))
    this.summaries = run.catch(() => undefined)
    return run
  }

  private summaries: Promise<void> = Promise.resolve()

  private async writeTurnSummary(answer: string): Promise<void> {
    const from = Math.max(this.request.since, this.summarizedTo)
    const steps = this.recent.filter(r => r.at >= from).length
    if (steps === 0) return
    // The turn's own explanations come first.
    const until = Date.now() + 120_000
    while ((this.isWorking || this.queue.length > 0) && Date.now() < until) await new Promise<void>(resolve => this.host.after(200, resolve))
    this.summarizedTo = Date.now()
    // The turn is over: its cards group in the feed, and what is explained from here on is the next one's.
    const turn = this.turnKey
    const asked = this.asked
    this.turnKey = this.newId()
    const settings = await this.settings()
    if (!settings.turnSummary || settings.mode !== 'auto' || settings.autoEngine !== 'model' || this.repo.notProject !== null) return
    // The steps' changes since the turn began (or the last summary), file by file.
    const byPath = new Map<string, string[]>()
    for (const { batch } of this.recent.filter(r => r.at >= from)) {
      for (const d of batch.diffs) byPath.set(d.path, [...(byPath.get(d.path) ?? []), d.hunks])
    }
    const files: InloopFileChange[] = []
    for (const [path, hunks] of byPath) {
      const summary = summarizeDiff(`--- a/${path}\n+++ b/${path}\n${hunks.join('\n')}`)[0]
      if (summary !== undefined) files.push(summary)
    }
    if (files.length === 0) return
    const explained = (await this.host.state.cards.get())
      .filter(c => c.source === 'auto' && c.turn === turn && c.skipped === undefined && c.failed === undefined)
      .reverse()
      .map(c => ({ title: c.title, summary: c.summary }))
    const written = await this.whileBusy('summarising this turn…', async () =>
      turnSummary(await this.env(), { request: this.request.text, from: this.request.from, answer, files, explained, isOneStep: steps === 1 }),
    ).catch(() => null)
    if (written === null) return
    await this.addCard({
      id: this.newId(),
      at: Date.now(),
      title: written.title,
      summary: written.summary,
      files: files.map(f => f.path),
      symbols: [],
      refs: files.map(f => ({ path: f.path, line: f.ranges[0]?.[0] })),
      steps: [],
      diff: files.map(f => `--- a/${f.path}\n+++ b/${f.path}\n${f.hunks}`).join('\n'),
      source: 'turn',
      ...(turn !== '' ? { turn, asked } : {}),
    })
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
   * Whole-file before and after text for a file's edits: the text each had
   * before it ran (Write read it first; Edit's record keeps it), else they are
   * undone on the text after, newest first. When that cannot be done exactly,
   * the last text inloop knew stands in, else the edits' own snippets.
   */
  private async toChange(group: RawEdit[]): Promise<FileChange> {
    const first = group[0]!
    const prior = this.baseline.get(first.rel)
    const change = await this.reconstruct(group, prior)
    if (!this.turnStart.has(first.rel)) {
      const known = change.after !== null ? change.before : first.before === null ? null : undefined
      this.turnStart.set(first.rel, known !== undefined ? known : prior !== undefined ? prior : await this.repo.read(first.rel, 'HEAD').catch(() => null))
    }
    return change
  }

  private async reconstruct(group: RawEdit[], prior: string | undefined): Promise<FileChange> {
    const rel = group[0]!.rel
    const after = await this.repo.read(rel).catch(() => null)
    if (after !== null) this.baseline.set(rel, after)
    // The next scan reads it again: a shell command may put back the content it last saw.
    this.prints.delete(rel)
    const base = { path: rel, tools: [...new Set(group.map(e => e.tool))], at: group[group.length - 1]!.at }
    const snippets = group.flatMap(e => editPairs(e.input)).map(p => ({ old: p.old, new: p.new }))
    const fallback = (): FileChange =>
      after !== null && prior !== undefined && group.every(e => e.tool !== 'NotebookEdit')
        ? { ...base, before: prior, after, snippets: [] }
        : { ...base, before: null, after: null, snippets }
    if (group.some(e => e.tool === 'NotebookEdit')) return fallback()
    let before: string | null = after
    for (const edit of [...group].reverse()) {
      if (edit.before !== undefined) {
        before = edit.before
        continue
      }
      if (edit.tool === 'Write' || before === null) return fallback()
      for (const p of editPairs(edit.input).reverse()) {
        // Not found, or found more than once: which one it was is not known.
        if (p.new === '' || !before.includes(p.new)) return fallback()
        if (!p.all && before.indexOf(p.new) !== before.lastIndexOf(p.new)) return fallback()
        before = p.all ? before.split(p.new).join(p.old) : before.replace(p.new, () => p.old)
      }
    }
    if (after === null) return { ...base, before: null, after: null, snippets }
    return { ...base, before, after, snippets: [] }
  }

  // ---- changes made outside the edit tools ---------------------------------------

  /**
   * The last text inloop knows of each file that differs from HEAD. A change made
   * by a shell command or a script is what differs from it; what was already
   * uncommitted when the session started is the person's, never explained.
   */
  private baseline = new Map<string, string>()
  /** A content fingerprint of every file that differed from HEAD when last scanned: a scan reads only what moved. */
  private prints = new Map<string, string>()
  /** Tracked files that were deleted when last scanned: a deletion counts once. */
  private gone = new Set<string>()
  /** The commit checked out when last scanned: a commit the agent makes shows what it changed. */
  private lastHead: string | undefined
  /** The scan running now, which a turn's end waits for; null between scans. */
  private scan: Promise<void> | null = null
  private isScanAgain = false

  private async snapshotBaseline(): Promise<void> {
    this.lastHead = await this.repo.head().catch(() => undefined)
    const entries = await this.repo.dirtyEntries().catch(() => [])
    const present = entries.filter(e => !e.isDeleted).map(e => e.path)
    this.gone = new Set(entries.filter(e => e.isDeleted).map(e => e.path))
    this.prints = await this.repo.fingerprints(present).catch(() => new Map<string, string>())
    // The text of the first few hundred, so a later change to one shows against your version, not HEAD's.
    for (const path of present.slice(0, 300)) {
      const text = await this.repo.readFresh(path)
      if (text !== null && text.length <= 400_000) this.baseline.set(path, text)
    }
  }

  /** A shell command ran: look for files it changed, off the agent's time. Scans in a burst coalesce. */
  noteShell(): void {
    if (this.scan !== null) {
      this.isScanAgain = true
      return
    }
    this.detach(() => this.scanWorkingTree())
  }

  /**
   * Finds files changed since inloop last saw them, by any means (a script, sed,
   * a formatter, a commit the agent made), and batches them like edits. A scan
   * already running goes round once more, and this waits for it. Absorbing (the
   * person's turn), what changed is learned as theirs and never explained.
   */
  async scanWorkingTree(isAbsorbing = false): Promise<void> {
    if (!this.repo.isGit || this.repo.notProject !== null) return
    while (this.scan !== null) {
      if (!isAbsorbing) {
        this.isScanAgain = true
        return this.scan
      }
      await this.scan.catch(() => undefined)
    }
    this.scan = this.scanLoop(isAbsorbing).finally(() => {
      this.scan = null
    })
    return this.scan
  }

  private async scanLoop(isAbsorbing: boolean): Promise<void> {
    do {
      this.isScanAgain = false
      const entries = await this.repo.dirtyEntries().catch(() => [])
      const present = entries.filter(e => !e.isDeleted).map(e => e.path)
      const deleted = new Set(entries.filter(e => e.isDeleted).map(e => e.path))
      const prints = await this.repo.fingerprints(present).catch(() => new Map<string, string>())
      // New commits: what they changed counts too, so a script that edits and commits in one command is still seen.
      const head = await this.repo.head().catch(() => undefined)
      let committed = new Set<string>()
      let committedFrom: string | undefined
      if (head !== undefined && this.lastHead !== undefined && head !== this.lastHead) {
        const moved = await this.repo.changedBetween(this.lastHead, head).catch(() => [] as string[])
        if (moved.length <= 40) {
          committed = new Set(moved)
          committedFrom = this.lastHead
        } else {
          // A checkout or a pull, not a step of work: the new tree is where things start.
          for (const path of moved) this.baseline.delete(path)
        }
      }
      this.lastHead = head
      const from = committedFrom ?? 'HEAD'
      let isFound = false
      let isMoved = false
      const candidates = new Set([...present, ...deleted, ...this.baseline.keys(), ...committed, ...this.prints.keys()])
      for (const path of candidates) {
        // An edit tool is already reporting this one.
        if (this.raw.some(r => r.rel === path)) continue
        const print = prints.get(path)
        const wasPrint = this.prints.get(path)
        if (!committed.has(path)) {
          // Unchanged since the last scan: dirty and the same content, or clean (or deleted) then and now.
          if (print !== undefined && print === wasPrint) continue
          if (print === undefined && wasPrint === undefined && !this.baseline.has(path) && deleted.has(path) === this.gone.has(path)) continue
        }
        if (print !== undefined) this.prints.set(path, print)
        else this.prints.delete(path)
        const now = await this.repo.readFresh(path)
        const known = this.baseline.has(path) ? this.baseline.get(path)! : await this.repo.read(path, from).catch(() => null)
        if (now === null) {
          // Deleted: explained as emptied, and gone from the changes since the prompt.
          this.baseline.delete(path)
          if (known === null) continue
          isMoved = true
          if (isAbsorbing) continue
          if (!this.turnStart.has(path)) this.turnStart.set(path, known)
          if (known.length > 400_000) continue
          this.batcher.add({ path, before: known, after: '', snippets: [], tools: ['Bash'], at: Date.now() })
          isFound = true
          continue
        }
        // Clean again and nothing to compare: drop it from the watch.
        if (print === undefined && !committed.has(path)) this.baseline.delete(path)
        if (now === known) continue
        if (print !== undefined || committed.has(path)) this.baseline.set(path, now)
        if (isAbsorbing) continue
        if (!this.turnStart.has(path)) this.turnStart.set(path, known)
        isMoved = true
        if (now.length > 400_000) continue
        this.batcher.add({ path, before: known, after: now, snippets: [], tools: ['Bash'], at: Date.now() })
        isFound = true
      }
      this.gone = deleted
      if (isFound) await this.schedule()
      if (isMoved) await this.refreshTurnChanges()
      // A scan asked for meanwhile is the agent's.
      isAbsorbing = false
    } while (this.isScanAgain)
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
      await this.refreshStatus()
    }
  }

  /** Makes a card for a batch if it is significant (and on topic in focus mode). */
  async explainBatch(batch: Batch, source: InloopCard['source'], force = false, titlePrefix = '', turn?: Pick<InloopCard, 'turn' | 'asked'>): Promise<InloopCard | null> {
    const settings = await this.settings()
    const score = Math.max(...batch.analyses.map(a => a.score), 0) + Math.min(2, batch.analyses.length - 1)
    // A small change is explained briefly; only one that changed nothing but whitespace or comments is left out.
    const isBrief = !force && score < settings.minScore
    if (isBrief && batch.analyses.every(a => a.isTrivial)) {
      await this.addSkipped(batch, 'only whitespace or comments changed')
      return null
    }
    const diffText = batch.diffs.map(d => d.hunks).join('\n')
    const focus = settings.mode === 'focus' ? settings.focus.trim() : ''
    if (!force && focus !== '' && !matchesFocus(focus, batch.analyses, diffText)) {
      // Keywords did not settle it: one cheap classification, when models are on.
      const verdict = settings.autoEngine !== 'model' ? 'unrelated' : await this.host.classify(
        `Focus topic: ${focus}\nFiles: ${batch.analyses.map(a => a.path).join(', ')}\nChange:\n${diffText.slice(0, 3000)}`,
        ['related', 'unrelated'],
        { model: settings.autoModel },
      ).catch(() => 'unrelated')
      if (verdict !== 'related') {
        await this.addSkipped(batch, `not about "${focus}"`)
        return null
      }
    }
    return this.whileBusy('explaining a change…', () => this.writeCard(batch, source, force, titlePrefix, focus, isBrief, turn))
  }

  private async writeCard(batch: Batch, source: InloopCard['source'], force: boolean, titlePrefix: string, focus: string, isBrief = false, turn?: Pick<InloopCard, 'turn' | 'asked'>): Promise<InloopCard | null> {
    const settings = await this.settings()
    const index = await this.repo.index().catch(() => null)
    const callers = index === null ? new Map<string, string[]>() : callerMap(index, batch.analyses)
    const base = staticCard(batch, callers, this.newId(), Date.now())
    base.source = source
    let card: InloopCard | null = isBrief ? { ...base, steps: base.steps?.slice(0, 1), isBrief: true } : base
    if (settings.autoEngine === 'model') {
      try {
        card = await modelCard(await this.env(), batch, base, force ? '' : focus, index ?? undefined, force, isBrief)
      } catch (err) {
        // inloop itself stopped (the session ended or restarted): nothing to show.
        if (this.aborter.signal.aborted) return null
        // Said plainly, with the change and a way to try again; never a bare list of code passed off as an explanation.
        card = this.inTurn({ ...base, ...turn, title: `${titlePrefix}${base.title}`, steps: [], failed: String((err as Error).message ?? err).replace(/^model call failed: /, '') })
        this.batches.set(card.id, { batch, source })
        await this.host.state.cards.update(list => [card!, ...list].slice(0, MAX_CARDS))
        return null
      }
    }
    if (card === null) {
      await this.addSkipped(batch, `not about "${focus}"`)
      return null
    }
    if (titlePrefix !== '') card = { ...card, title: `${titlePrefix}${card.title}` }
    await this.addCard(this.inTurn({ ...card, ...turn }))
    return card
  }

  /** An automatic card, marked with the turn it was written in. */
  private inTurn(card: InloopCard): InloopCard {
    return card.source === 'auto' && this.turnKey !== '' && card.turn === undefined ? { ...card, turn: this.turnKey, asked: this.asked } : card
  }

  /** The batch behind each skipped or failed card, for "explain anyway" and "try again". */
  private batches = new Lru<{ batch: Batch; source: InloopCard['source'] }>(60)

  /** A change not explained still shows: one line in the feed, with its changes and "explain anyway". Never read aloud. */
  private async addSkipped(batch: Batch, reason: string): Promise<void> {
    const card: InloopCard = this.inTurn({ ...staticCard(batch, new Map(), this.newId(), Date.now()), steps: [], skipped: reason, root: this.repo.root })
    this.batches.set(card.id, { batch, source: 'auto' })
    await this.host.state.cards.update(list => [card, ...list].slice(0, MAX_CARDS))
  }

  /** Cards whose "explain anyway" or "try again" is running: a second press of it does nothing. */
  private explaining = new Set<string>()

  /**
   * Explains a skipped change, or tries a failed one again; the new explanation
   * takes its place. A card from before a reload, whose change inloop no longer
   * holds, is explained from the diff it carries.
   */
  async explainAgain(id: string): Promise<void> {
    if (this.explaining.has(id)) return
    this.explaining.add(id)
    try {
      const card = (await this.host.state.cards.get()).find(c => c.id === id)
      // Already explained (a second press that landed before the pane redrew): nothing more to do.
      if (card === undefined) return
      const held = this.batches.get(id) ?? fromDiff(card)
      if (held === undefined) {
        await this.report('That change is no longer held; ask about it instead.')
        return
      }
      this.batches.delete(id)
      await this.host.state.cards.update(list => list.filter(c => c.id !== id))
      // Explained in its place: in the turn it was made in.
      await this.explainBatch(held.batch, held.source, true, '', card.turn === undefined ? undefined : { turn: card.turn, asked: card.asked })
    } finally {
      this.explaining.delete(id)
    }
  }

  async addCard(raw: InloopCard, options: { inFeed?: boolean } = {}): Promise<void> {
    const card = { ...(await this.withSteps(raw)), root: this.repo.root }
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
    // A headless run (-p, SDK) has no one listening: its explanations are never read aloud.
    if (settings.style === 'spoken' && !this.isHeadless) void this.narrate(card)
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
    const found = `${this.isKokoroReady ? 'kokoro,' : ''}${this.voices.map(v => v.name).join(',')}`
    await this.host.state.status.update(s => (s.voicesFound === found ? s : { ...s, voicesFound: found }))
    return this.voices
  }

  /** The engine and voice a setting speaks with ('' = the best available: Kokoro once set up). */
  voicePlan(setting: string): VoicePlan {
    return planVoice(setting, this.canUseKokoro, this.voices)
  }

  /** Kokoro is set up and this machine can play what it renders. */
  get canUseKokoro(): boolean {
    return this.isKokoroReady && this.host.canPlayClips
  }

  private voiceSetup: Promise<string> | null = null

  /**
   * At start: finds the voices, and when the natural voice is missing, sets it up
   * in the background (a one-time download, uv too when it is missing). The Mac's voice speaks meanwhile.
   */
  async prepareVoice(): Promise<void> {
    await this.refreshVoices()
    const settings = await this.settings()
    // Nothing to fetch where its audio could not be played. Without uv, setup fetches inloop's own copy first.
    if (this.isKokoroReady || !settings.autoVoiceSetup || this.isHeadless || !this.host.canPlayClips) return
    const said = await this.setupKokoro()
    if (this.isKokoroReady) this.host.toast(`inloop: ${said}`, { timeoutMs: 6000 })
  }

  /** Installs Kokoro (one download), then makes it the voice. One setup at a time. */
  setupKokoro(): Promise<string> {
    if (this.voiceSetup !== null) return this.voiceSetup
    const run = async (): Promise<string> => {
      if (!this.host.canPlayClips) return NO_PLAYER
      if (this.canUseKokoro) return 'The natural voice (Kokoro) is already set up.'
      await this.host.state.status.update(s => ({ ...s, isVoiceSettingUp: true }))
      await this.refreshStatus()
      try {
        // Without uv, inloop fetches its own copy first (into its cache, nothing system-wide).
        if (!this.host.hasUv) {
          const got = await this.host.getUv()
          if (!got.ok) return `The natural voice could not be set up: ${got.text}. Until then inloop uses the system voice.`
        }
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
    // A change explained in its summary alone was meant that way: no parts made up from its references.
    if ((card.source === 'auto' || card.source === 'turn') && card.steps !== undefined && !card.isHeuristic) return card
    const steps: InloopStep[] = []
    for (const ref of card.refs.slice(0, 5)) {
      if (ref.line === undefined) continue
      steps.push(await captureStep(this.repo, ref.label ?? `${ref.path}, line ${ref.line}`, { ...ref, label: undefined }))
    }
    return { ...card, steps }
  }

  // ---- narration -----------------------------------------------------------------

  private narrationQueue: Queued[] = []
  private isNarrating = false
  private speakerNow: Speaker | null = null
  /** The explanation being read (its audio counts toward the few kept made). */
  private playing: Queued | null = null
  private control: 'none' | 'next' | 'prev' | 'pause' | 'stop' | 'skip' = 'none'
  private resume: (() => void) | null = null
  private autoOpened: string | null = null
  /** The person closed the pane themselves; inloop does not reopen it until they ask (/inloop). */
  isPaneClosedByPerson = false
  /** Away (/inloop-away): explanations are queued, not read, until /inloop-play. */
  private isAway = false

  /**
   * The explanation last read, kept loaded once it ends or is stopped: replay
   * reads it again from part 1 with the audio already made. It is let go only
   * when closed, when other audio plays, or when the session ends.
   */
  private held: { card: InloopCard; steps: InloopStep[]; speaker: Speaker; stale: { isStale: boolean } } | null = null
  private isReplaying = false
  private isClosing = false

  /** Lets the kept explanation and its audio go. */
  private release(): void {
    if (this.held === null) return
    this.held.speaker.close()
    this.held = null
    this.prerender()
  }

  /** Empties the queue, letting its audio go. */
  private clearQueue(): void {
    for (const e of this.narrationQueue) void e.speaker?.then(sp => sp.close())
    this.narrationQueue = []
  }

  /**
   * What a stop or close lets go of: the explanations waiting to be read. While
   * away, those wait for /inloop-play and are kept; only one asked for goes.
   */
  private dropWaiting(): void {
    if (!this.isAway) return this.clearQueue()
    for (const e of this.narrationQueue.filter(e => e.isAsked)) void e.speaker?.then(sp => sp.close())
    this.narrationQueue = this.narrationQueue.filter(e => !e.isAsked)
  }

  /**
   * Queues a card to be read aloud, its code shown part by part. `first` (a
   * press of listen) reads it now, ahead of the rest, even while away.
   */
  async narrate(card: InloopCard, first = false): Promise<void> {
    // The explanation itself first (the answer, or the change's summary), then each part with its code.
    const steps: InloopStep[] = [{ text: card.summary, ref: { path: '' } }, ...(card.steps ?? [])]
    if (first) {
      const had = this.narrationQueue.find(e => e.card.id === card.id)
      this.narrationQueue = [
        { card, steps, speaker: had?.speaker ?? null, isRendered: had?.isRendered ?? false, isAsked: true, isAway: false },
        ...this.narrationQueue.filter(e => e.card.id !== card.id),
      ]
      if (this.isNarrating) this.interrupt('skip')
    } else {
      if (this.narrationQueue.length >= NARRATION_MAX) return
      this.narrationQueue.push({ card, steps, speaker: null, isRendered: false, isAsked: false, isAway: this.isAway })
    }
    await this.host.state.narration.update(n => (n === null ? n : { ...n, queued: this.narrationQueue.length }))
    this.prerender()
    this.startNarration()
    await this.refreshStatus()
  }

  /** The next explanation to read: the first waiting, or while away only one asked for. */
  private nextToRead(): Queued | undefined {
    const head = this.narrationQueue[0]
    return head !== undefined && (!this.isAway || head.isAsked) ? head : undefined
  }

  private startNarration(): void {
    if (this.isNarrating || this.nextToRead() === undefined) return
    this.isNarrating = true
    this.detach(() => this.runNarration())
  }

  /** A queued explanation's speaker, made once (by whichever asks first: reading it or rendering ahead). */
  private speakerOf(entry: Queued): Promise<Speaker> {
    this.dropStale(entry)
    if (entry.speaker === null) {
      entry.speaker = this.newSpeaker(entry.steps)
      entry.isStale = false
      const made = entry.speaker
      // Only this speaker's audio ages: one made again later starts fresh.
      this.host.after(AUDIO_KEEP_MS, () => { if (entry.speaker === made) entry.isStale = true })
    }
    return entry.speaker
  }

  private newSpeaker(steps: readonly InloopStep[]): Promise<Speaker> {
    return this.speaker(
      steps.map((st, i) => speakable(st.text, i === 0 ? 900 : 320)),
      () => this.currentControl() !== 'none',
      isPreparing => this.host.state.narration.update(n => (n === null ? n : { ...n, isPreparing })).then(() => undefined),
    )
  }

  /** A mark that goes stale once audio made now may have been deleted. */
  private staleIn(): { isStale: boolean } {
    const mark = { isStale: false }
    this.host.after(AUDIO_KEEP_MS, () => { mark.isStale = true })
    return mark
  }

  /** Audio made ahead long enough ago that its clips may be gone (after a long time away) is let go, to be made again. */
  private dropStale(entry: Queued): void {
    if (entry.speaker === null || entry.isStale !== true) return
    void entry.speaker.then(s => s.close(), () => undefined)
    entry.speaker = null
    entry.isRendered = false
    entry.isStale = false
  }

  private isRendering = false

  /**
   * Makes the audio of the explanations waiting, in order, one at a time (each
   * Kokoro render is its own process), so they play without a wait. At most
   * AUDIO_MAX explanations' audio is kept at once, counting the one being read
   * and the one kept to replay; the rest wait as text until a place frees up.
   */
  private prerender(): void {
    if (this.isRendering) return
    this.isRendering = true
    this.detach(async () => {
      try {
        for (const entry of this.narrationQueue) this.dropStale(entry)
        for (;;) {
          const kept = (this.held !== null ? 1 : 0) + (this.playing !== null ? 1 : 0) + this.narrationQueue.filter(e => e.speaker !== null).length
          const next = this.narrationQueue.find(e => e.speaker === null)
          if (next === undefined || kept >= AUDIO_MAX || this.aborter.signal.aborted) break
          const speaker = await this.speakerOf(next)
          await speaker.rendered
          next.isRendered = true
          await this.refreshStatus()
        }
      } finally {
        this.isRendering = false
      }
    })
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

  /** Speaks faster (1) or slower (-1), from the next part read. */
  async changeRate(step: 1 | -1): Promise<number> {
    const rate = nextRate((await this.settings()).speechRate ?? 1, step)
    await this.setSettings({ speechRate: rate })
    return rate
  }

  /** Stops reading; the explanation stays loaded at part 1, to replay or close. */
  narrationStop(): void {
    this.dropWaiting()
    this.interrupt('stop')
  }

  /** Reads the kept explanation again from part 1, with the audio already made. */
  narrationReplay(): void {
    if (this.held === null || this.isNarrating) return
    this.isReplaying = true
    this.isNarrating = true
    this.detach(() => this.runNarration())
  }

  /** Stops reading if it is, and unloads the explanation and its audio. */
  async narrationClose(): Promise<void> {
    this.dropWaiting()
    if (this.isNarrating) {
      this.isClosing = true
      this.interrupt('stop')
      return
    }
    this.release()
    await this.host.state.narration.update(() => null)
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
    // The speed is read as each piece starts, so a change applies from the next one.
    const rate = async () => (await this.settings()).speechRate ?? 1
    const direct = async (text: string): Promise<void> => {
      const handle = this.host.say(text, systemName, await rate())
      current = handle
      await handle.done.catch(() => undefined)
      current = null
    }
    if (plan.engine === 'system') {
      return { play: i => direct(texts[i] ?? ''), stopPiece: () => current?.stop(), close: () => current?.stop(), rendered: Promise.resolve() }
    }
    // Where the player cannot change speed, Kokoro renders at it.
    const synth = this.host.synthesize(texts, plan.id, this.host.playsAtRate ? 1.0 : await rate())
    const ready: (string | null | undefined)[] = texts.map(() => undefined)
    const waiters = new Map<number, () => void>()
    let isDone: () => void = () => undefined
    const rendered = new Promise<void>(resolve => { isDone = resolve })
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
      isDone()
    })()
    return {
      rendered,
      play: async i => {
        if (ready[i] === undefined) {
          // Rendering is behind (the first part, while the model loads): say so until it is ready.
          const done = new Promise<void>(resolve => {
            waiters.set(i, resolve)
            cancelWait = resolve
          })
          await this.preparingAudio(true, onPreparing)
          try {
            if (ready[i] === undefined) await done
          } finally {
            await this.preparingAudio(false, onPreparing)
          }
        }
        cancelWait = null
        if (isInterrupted()) return
        const path = ready[i]
        if (path === undefined) return
        if (path === null) return direct(texts[i] ?? '')
        const handle = this.host.play(path, this.host.playsAtRate ? await rate() : 1)
        current = handle
        // A clip that could not be played is said by the platform voice instead, never skipped in silence.
        const isPlayed = await handle.done.then(() => true, () => false)
        current = null
        if (!isPlayed && !isInterrupted()) await direct(texts[i] ?? '')
      },
      stopPiece: () => {
        current?.stop()
        cancelWait?.()
      },
      close: () => {
        current?.stop()
        cancelWait?.()
        synth.stop()
        isDone()
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
      for (;;) {
        let card: InloopCard
        let steps: InloopStep[]
        let speaker: Speaker
        let writtenAt: number | undefined
        let stale = { isStale: false }
        if (this.isReplaying && this.held !== null) {
          ;({ card, steps, speaker, stale } = this.held)
          // Kept to replay for long enough that its clips may be gone: made again.
          if (stale.isStale) {
            speaker.close()
            speaker = await this.newSpeaker(steps)
            stale = this.staleIn()
          }
          this.held = null
        } else {
          const entry = this.nextToRead()
          if (entry === undefined) break
          this.narrationQueue.shift()
          // Another explanation is read: the one kept to replay goes.
          this.release()
          this.playing = entry
          ;({ card, steps } = entry)
          writtenAt = entry.isAway ? card.at : undefined
          speaker = await this.speakerOf(entry)
          // Its clips age from when they were made (the entry's own mark goes stale with them).
          const made = entry
          stale = { get isStale() { return made.isStale === true } }
        }
        this.isReplaying = false
        this.control = 'none'
        this.oneOff?.close()
        // The code is shown as it is discussed: bring the pane back if it went away on its own,
        // but not if the person closed it (the band above the prompt stands in then).
        if (!this.isPaneClosedByPerson) void this.host.openPane().catch(() => undefined)
        await this.host.state.narration.update(() => ({ cardId: card.id, title: card.title, steps, index: 0, isPaused: false, queued: this.narrationQueue.length, writtenAt }))
        await this.refreshStatus()
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
          this.speakerNow = null
          this.playing = null
        }
        // The last one read stays loaded, to replay; one with more to read behind it goes.
        // (A stop emptied the queue; whatever is queued now came after it and is read.)
        if (this.nextToRead() !== undefined || this.isClosing) speaker.close()
        else this.held = { card, steps, speaker, stale }
        this.prerender()
      }
    } finally {
      this.isNarrating = false
      this.control = 'none'
      this.speakerNow = null
      this.playing = null
      if (this.isClosing || this.held === null) {
        this.isClosing = false
        this.release()
        await this.host.state.narration.update(() => null)
      } else {
        await this.host.state.narration.update(n => (n === null ? n : { ...n, index: 0, isPaused: false, isPreparing: false, isEnded: true, queued: 0 }))
      }
      await this.refreshStatus()
    }
  }

  // ---- away ----------------------------------------------------------------------

  /**
   * /inloop-away: changes go on being explained, but nothing is read aloud;
   * the explanations wait for /inloop-play, the first few with their audio made.
   * A paused or ask mode explains changes meanwhile and comes back after.
   */
  async goAway(): Promise<string> {
    const settings = await this.settings()
    if (isAwayOn(settings)) return `Already away since ${clock(settings.away!.since)}; ${this.narrationQueue.length} waiting. /inloop-play when you are back.`
    const from = settings.mode === 'paused' || settings.mode === 'ask' ? settings.mode : null
    await this.setSettings({ away: { since: Date.now(), from }, ...(from !== null ? { mode: 'auto' as const } : {}) })
    // No one is listening now: what was being read waits with the rest, from part 1.
    const now = this.playing
    if (now !== null && !now.isAsked) {
      this.narrationQueue.unshift({ ...now, speaker: null, isRendered: false, isAway: true })
      this.isClosing = true
      this.interrupt('stop')
    }
    const style = settings.style === 'spoken' ? 'queued with the audio of the next few made' : 'kept in the feed, marked'
    return `Away. New changes are explained and ${style}${from !== null ? ` (mode is auto until you are back, then ${from} again)` : ''}. /inloop-play when you are back.`
  }

  /** /inloop-play: back from away; reads what waits (spoken), or opens the first one written meanwhile. */
  async comeBack(): Promise<string> {
    const settings = await this.settings()
    const away = settings.away
    if (isAwayOn(settings)) {
      await this.setSettings({
        away: { ...away!, until: Date.now() },
        ...(away!.from !== null && settings.mode === 'auto' ? { mode: away!.from } : {}),
      })
    }
    const back = away !== null && away.from !== null && settings.mode === 'auto' && away.until === undefined ? ` Mode is ${away.from} again.` : ''
    if (settings.style === 'spoken' && !this.isHeadless) {
      const count = this.narrationQueue.length
      if (count === 0) return `Nothing is waiting to be read.${back}`
      this.startNarration()
      return `Reading ${count} explanation${count === 1 ? '' : 's'}, oldest first.${back}`
    }
    if (away === null) return `Nothing was written while you were away.${back}`
    const until = away.until ?? Date.now()
    const written = (await this.host.state.cards.get()).filter(c => (c.source === 'auto' || c.source === 'turn') && c.at >= away.since && c.at <= until)
    if (written.length === 0) return `Nothing was written while you were away.${back}`
    const oldest = written[written.length - 1]!
    await this.host.state.expanded.update(() => oldest.id)
    this.autoOpened = null
    await this.setTab('feed')
    return `${written.length} explanation${written.length === 1 ? ' was' : 's were'} written while you were away; the oldest is open.${back}`
  }

  private oneOff: Speaker | null = null

  /**
   * Says one short thing (a voice test, a confirmation) with the chosen voice.
   * One voice at a time: it is skipped while an explanation is being read, and
   * an explanation starting cuts it off.
   */
  async speak(text: string): Promise<void> {
    if (this.isNarrating) return
    // Other audio: the kept explanation goes (what waits to be read stays).
    if (this.held !== null) {
      this.release()
      await this.host.state.narration.update(() => null)
    }
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

  /**
   * Queues a question; the answer lands where it was asked (the Ask tab's
   * conversation, or the tab or explanation that asked) and in the history,
   * never in the feed of changes. `label` is what is shown for a question a
   * button asked.
   */
  ask(question: string, kind: AskKind = 'question', label?: string, place: AskPlace = 'ask'): Promise<void> {
    const run = async (): Promise<void> => {
      const turn: InloopTurn = { role: 'you', text: question, at: Date.now(), label }
      if (place === 'ask') {
        await this.host.state.askOpen.update(() => null)
        await this.host.state.convo.update(c => [...c, turn].slice(-40))
      } else {
        await this.putAnswer(place, { q: turn })
      }
      try {
        await this.whileBusy(kind === 'flow' ? 'tracing the flow…' : 'investigating…', progress => this.answer(question, kind, label, place, turn, progress))
      } catch (err) {
        const msg = err instanceof RepoError ? err.message : String((err as Error).message ?? err)
        const failed: InloopTurn = { role: 'inloop', text: `Could not answer: ${msg}`, at: Date.now() }
        if (place === 'ask') await this.host.state.convo.update(c => [...c, failed])
        else await this.putAnswer(place, { q: turn, a: failed })
        await this.report(msg)
      }
    }
    this.askChain = this.askChain.then(run, run)
    return this.askChain
  }

  /** Shows a question, or its answer, in the tab or explanation that asked. */
  private async putAnswer(place: Exclude<AskPlace, 'ask'>, ex: InloopExchange): Promise<void> {
    await this.host.state.answers.update(a => (
      typeof place === 'object' ? { ...a, cards: { ...a.cards, [place.card]: ex } } : { ...a, [place]: ex }
    ))
  }

  /** Lets go of an answer shown in a tab or an explanation. */
  async dismissAnswer(place: Exclude<AskPlace, 'ask'>): Promise<void> {
    await this.host.state.answers.update(a => {
      if (typeof place !== 'object') return { ...a, [place]: undefined }
      const { [place.card]: _, ...cards } = a.cards
      return { ...a, cards }
    })
  }

  private async answer(question: string, kind: AskKind, label: string | undefined, place: AskPlace, turn: InloopTurn, progress: (text: string) => void): Promise<void> {
    const env = await this.env(progress, place === 'ask')
    const result = await ask(env, question, kind)
    const reply: InloopTurn = { role: 'inloop', text: result.answer, at: Date.now(), refs: result.refs, steps: result.steps }
    if (place === 'ask') await this.host.state.convo.update(c => [...c, reply].slice(-40))
    else await this.putAnswer(place, { q: turn, a: reply })
    if (result.scope !== undefined) await this.host.state.ctx.update(c => ({ ...c, scope: result.scope === '' ? undefined : result.scope }))
    if (result.rev !== env.ctx.rev) await this.host.state.ctx.update(c => ({ ...c, rev: result.rev, revLabel: result.revLabel }))
    let flowId: string | undefined
    if (result.flow !== null) {
      await this.showFlow(result.flow, false)
      flowId = result.flow.id
    } else if (kind === 'flow') {
      // Nothing to trace: the first draw from the question's names goes too.
      const drawn = await this.host.state.flow.get()
      if (drawn?.isDraft === true && drawn.title === question) await this.host.state.flow.update(() => null)
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
    // Asked in the Ask tab, the code it points at is ready in Code; elsewhere each tab keeps what it shows.
    const first = result.refs[0]
    if (first !== undefined && place === 'ask') await this.openRef(first, { switchTab: false })
    if (!(await this.isPaneShown())) this.host.log(`inloop — ${question}\n\n${result.answer}`)
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
    try {
      const card = await this.whileBusy(`explaining commit ${rev.slice(0, 8)}…`, async progress => explainCommit(await this.env(t => progress(`${t}…`)), rev))
      await this.addCard(card)
      await this.host.state.expanded.update(() => card.id)
      if (!(await this.isPaneShown())) this.host.log(`inloop — ${card.title}\n\n${card.summary}`)
      return card
    } catch (err) {
      await this.report(String((err as Error).message ?? err))
      return null
    }
  }

  async compare(from: string, to: string, topic: string): Promise<InloopCard | null> {
    try {
      const card = await this.whileBusy('comparing revisions…', async progress => compareRevs(await this.env(t => progress(`${t}…`)), from, to, topic))
      await this.addCard(card)
      await this.host.state.expanded.update(() => card.id)
      if (!(await this.isPaneShown())) this.host.log(`inloop — ${card.title}\n\n${card.summary}`)
      return card
    } catch (err) {
      await this.report(String((err as Error).message ?? err))
      return null
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
      await this.report(String((err as Error).message))
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
    const flow = await staticFlow(this.repo, query, ctx.rev, this.newId(), Date.now())
    return flow === null ? null : { ...flow, isDraft: true }
  }

  async selectNode(nodeId: string): Promise<void> {
    const flow = await this.host.state.flow.get()
    if (flow === null) return
    const node = flow.nodes.find(n => n.id === nodeId)
    if (node === undefined) return
    await this.host.state.flowSelected.update(() => nodeId)
    // What the trace said about the step shows at once; the closer reading replaces it.
    await this.host.state.flowNote.update(() => (node.note !== undefined ? `${node.note}\n\n*Reading this step…*` : 'Reading this step…'))
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
      await this.report(String((err as Error).message ?? err))
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
    this.isAway = isAwayOn(next)
    if (change.voice !== undefined || (change.speechRate !== undefined && !this.host.playsAtRate)) {
      // Audio made ahead in the old voice (or at a speed the player cannot change) is made again.
      const waiting = this.narrationQueue.map(e => ({ ...e, speaker: null, isRendered: false }))
      this.clearQueue()
      this.narrationQueue = waiting
      this.prerender()
    }
    if (change.style === 'written') {
      void this.narrationClose()
      // Nothing is read in written style, so nothing waits to be (an away feed marks what was written).
      this.clearQueue()
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

  /** Deletes one saved explanation, here and in the store other sessions share; the feed drops it too. */
  async deleteExplanation(id: string): Promise<void> {
    await this.host.state.cards.update(list => list.filter(c => c.id !== id))
    await this.host.state.expanded.update(cur => (cur === id ? null : cur))
    const history = await this.host.state.history.update(list => list.filter(c => c.id !== id))
    await this.persistHistory(history, [id])
    await this.refreshStatus()
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
    else mergeChange(held, c)
  }
  const changes = [...byPath.values()]
  return { changes, analyses: changes.map(analyzeChange), diffs: diffBatch(changes) }
}

/**
 * The change behind a card, rebuilt from the diff it carries: what "explain
 * anyway" works from once the batch itself is gone (a reload, a restart).
 */
function fromDiff(card: InloopCard): { batch: Batch; source: InloopCard['source'] } | undefined {
  const files = summarizeDiff(card.diff ?? '').filter(f => f.hunks !== '')
  if (files.length === 0) return undefined
  const changes: FileChange[] = files.map(f => {
    const lines = f.hunks.split('\n').filter(l => !l.startsWith('@@') && !l.startsWith('\\'))
    const side = (mark: string) => lines.filter(l => l.startsWith(mark) || l.startsWith(' ')).map(l => l.slice(1)).join('\n')
    return { path: f.path, before: null, after: null, snippets: [{ old: side('-'), new: side('+') }], tools: [], at: card.at }
  })
  return { batch: { changes, analyses: changes.map(analyzeChange), diffs: files.map(f => ({ path: f.path, hunks: f.hunks })) }, source: card.source }
}

/** The replacements an Edit, MultiEdit or NotebookEdit made, in order. */
function editPairs(input: Record<string, unknown>): { old: string; new: string; all: boolean }[] {
  const pairs: { old: string; new: string; all: boolean }[] = []
  const collect = (o: Record<string, unknown>) => {
    if (typeof o.old_string === 'string' && typeof o.new_string === 'string') {
      pairs.push({ old: o.old_string, new: o.new_string, all: o.replace_all === true })
    } else if (typeof o.new_source === 'string') {
      pairs.push({ old: '', new: o.new_source, all: false })
    }
  }
  if (Array.isArray(input.edits)) for (const one of input.edits) collect(one as Record<string, unknown>)
  else collect(input)
  return pairs
}

/** A failure that waiting may cure: rate limits, overload, server errors, no response, a call cut off under inloop. */
function isPassing(r: { isAnswered: false; reason: string; status?: number | null }): boolean {
  if (r.reason === 'aborted') return true
  if (r.reason !== 'api-error') return false
  const status = r.status ?? null
  return status === null || status === 408 || status === 409 || status === 429 || status >= 500
}

/** Away now: /inloop-away was used and /inloop-play not yet. */
export function isAwayOn(settings: InloopSettings): boolean {
  return settings.away !== null && settings.away !== undefined && settings.away.until === undefined
}

function clock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
