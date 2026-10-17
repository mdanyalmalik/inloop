export type InloopDepth = 'beginner' | 'intermediate' | 'advanced'
export type InloopMode = 'auto' | 'ask' | 'focus' | 'paused'
/** How explanations reach you: read in the panel, or narrated with the code shown step by step. */
export type InloopStyle = 'written' | 'spoken'
export type InloopTab = 'feed' | 'code' | 'flow' | 'ask' | 'history' | 'git' | 'settings'

/** A pointer into the code: a file, a line range, and the revision it belongs to. */
export type InloopRef = {
  path: string
  line?: number
  endLine?: number
  /** A commit sha; absent means the working tree. */
  rev?: string
  label?: string
  symbol?: string
}

/** One part of an explanation: a sentence or two, and the code it is about. */
export type InloopStep = {
  text: string
  ref: InloopRef
  /** The lines of code as they were when explained. */
  code?: string
  /** The line number `code` starts at. */
  codeStart?: number
}

/** One explanation in the feed or the history. */
export type InloopCard = {
  id: string
  at: number
  title: string
  concept?: string
  /** Markdown. */
  summary: string
  files: string[]
  symbols: string[]
  refs: InloopRef[]
  /** The explanation walked through in order, each part with its code. */
  steps?: InloopStep[]
  /** Every file a commit or comparison changed, with its counts (the diff holds only the files read). */
  fileStats?: { path: string; added: number; removed: number }[]
  /** Unified diff hunks behind the card, when it explains a change. */
  diff?: string
  rev?: string
  source: 'auto' | 'ask' | 'commit' | 'compare' | 'recent' | 'flow'
  question?: string
  bookmarked?: boolean
  /** True when no model call was made (static analysis only). */
  isHeuristic?: boolean
  /** A change inloop chose not to explain, and why; shown as one line with "explain anyway". */
  skipped?: string
  /** The explanation could not be written (the model call failed), and why; shown with "try again". */
  failed?: string
  /** The project the explanation belongs to, so a new session's feed starts with its own. */
  root?: string
  flowId?: string
}

export type InloopConfidence = 'confirmed' | 'inferred' | 'runtime'

export type InloopFlowNode = {
  id: string
  label: string
  kind: string
  ref?: InloopRef
  depth: number
}

export type InloopFlowEdge = {
  from: string
  to: string
  label: string
  confidence: InloopConfidence
}

export type InloopFlow = {
  id: string
  title: string
  rev?: string
  nodes: InloopFlowNode[]
  edges: InloopFlowEdge[]
  notes: string[]
  at: number
}

export type InloopViewer = {
  path: string
  rev?: string
  /** First highlighted line (1-based). */
  line: number
  endLine: number
  /** First line drawn. */
  top: number
  /** Unified diff to draw instead of the file, when set. */
  diff?: string
  note?: string
}

/** One screen to come back to: the tab, the code open, and the explanation expanded. */
export type InloopNav = {
  tab: InloopTab
  viewer: InloopViewer | null
  expanded: string | null
}

export type InloopTurn = {
  role: 'you' | 'inloop'
  text: string
  at: number
  refs?: InloopRef[]
  /** An answer's parts, each with its code. */
  steps?: InloopStep[]
  /** What the conversation shows for a question asked by a button ("simpler: …"). */
  label?: string
}

export type InloopSettings = {
  mode: InloopMode
  depth: InloopDepth
  focus: string
  /** Written explanations with snippets, or narration with the code shown as it is discussed. */
  style: InloopStyle
  /** Ask the coding agent to keep its own replies short while inloop explains the changes. */
  briefAgent: boolean
  /** System voice to speak with; '' picks the best installed. */
  voice: string
  /** Download the natural Kokoro voice in the background when a session starts, if it is not there yet. */
  autoVoiceSetup: boolean
  /** Model for automatic change explanations. */
  autoModel: string
  /** Model for questions, flows and commits. */
  askModel: string
  /** Questions are investigated by inloop's reader, a read-only Claude Code agent; off, by inloop's own lookups. */
  useReader: boolean
  /** 'model' asks a model for automatic cards; 'static' explains from analysis alone. */
  autoEngine: 'model' | 'static'
  /** Minimum significance score (0-10) before a change batch gets a card. */
  minScore: number
  /** Seconds of quiet after the last edit before a batch is explained. */
  quietSeconds: number
  /** Away: explanations are written and queued, not read aloud, until /inloop-play. Kept after it ends (`until`) to mark what was written meanwhile. */
  away: InloopAway | null
}

export type InloopAway = {
  since: number
  /** When the person came back; unset while away. */
  until?: number
  /** The mode to go back to: away explains changes, so a paused or ask mode becomes auto meanwhile. */
  from: InloopMode | null
}

/** What the person is looking at: questions are answered about this. */
export type InloopContext = {
  rev?: string
  revLabel?: string
  path?: string
  line?: number
  endLine?: number
  symbol?: string
  flowId?: string
  cardId?: string
  scope?: string
}

export type InloopCommit = {
  sha: string
  short: string
  author: string
  date: string
  subject: string
}

export type InloopGitView = {
  query: string
  commits: InloopCommit[]
  selected?: string
  files: { status: string; path: string }[]
  compareFrom?: string
  error?: string
}

/** The explanation being read aloud, and where in it the narration is. */
export type InloopNarration = {
  cardId: string
  title: string
  steps: InloopStep[]
  /** The step being read; -1 while the title is read. */
  index: number
  isPaused: boolean
  /** Explanations waiting to be read after this one. */
  queued: number
  /** The voice is still rendering the part to read (Kokoro can take a few seconds). */
  isPreparing?: boolean
  /** Finished or stopped: kept loaded at part 1, to replay (the audio already made) or close. */
  isEnded?: boolean
  /** When an explanation written while the person was away was written. */
  writtenAt?: number
}

/** One file's net change since the person's last prompt. */
export type InloopFileChange = {
  path: string
  added: number
  removed: number
  /** New-side line ranges changed, as [first, last]. */
  ranges: [number, number][]
  /** This file's hunks, from its text at the prompt to its text now. */
  hunks: string
  isNew?: boolean
  isDeleted?: boolean
}

/** What the files went through since the person's last prompt, net: an edit undone shows no change. */
export type InloopTurnChanges = {
  /** When the prompt was sent; 0 before the first one. */
  since: number
  files: InloopFileChange[]
}

export type InloopUsage = { calls: number; inputTokens: number; outputTokens: number }

export type InloopStatus = {
  busy: string | null
  queued: number
  pendingChanges: number
  recentBatches: number
  lastError?: string
  /** Speech is being rendered and nothing is playing yet. */
  isPreparingAudio?: boolean
  /** Explanations waiting to be read aloud, and how many of them have their audio ready. */
  waiting?: number
  voiced?: number
  /** The natural voice is being downloaded and set up. */
  isVoiceSettingUp?: boolean
  /** The voices found when last looked for: the pane's voice controls are drawn again when they change. */
  voicesFound?: string
}

/** A question and, once ready, its answer. */
export type InloopExchange = { q: InloopTurn; a?: InloopTurn }

/** Answers kept in the tab that asked for them, away from the Ask tab's conversation. */
export type InloopAnswers = {
  /** "explain these lines" in the Code tab. */
  code?: InloopExchange
  /** A traced flow's explanation, under its diagram in the Flow tab. */
  flow?: InloopExchange
  /** "go deeper" on an explanation, shown inside it, by its id. */
  cards: Record<string, InloopExchange>
}

declare module 'claude-code' {
  interface PluginState {
    inloop: {
      cards: InloopCard[]
      history: InloopCard[]
      tab: InloopTab
      expanded: string | null
      viewer: InloopViewer | null
      nav: InloopNav[]
      flow: InloopFlow | null
      flowSelected: string | null
      flowNote: string | null
      convo: InloopTurn[]
      answers: InloopAnswers
      /** The earlier question opened in the Ask tab, by its time. */
      askOpen: number | null
      settings: InloopSettings
      ctx: InloopContext
      git: InloopGitView
      usage: InloopUsage
      status: InloopStatus
      narration: InloopNarration | null
      changes: InloopTurnChanges
      /** Advances while something is being generated, to animate the spinners. */
      frame: number
    }
  }
}
