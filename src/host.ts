// What inloop's logic may ask of Claude Code. The hooks module builds this
// from closures that each spell their own `$` call, so `claude plugin
// validate` sees every engine call the plugin makes; nothing here can write
// to the project (there is no file write, and processes run are git reads).

import type {
  PluginState,
  ClassifyOptions,
  FsEntry,
  ModelCompleteOptions,
  ModelCompleteRequest,
  ModelCompleteResult,
  ProcessRunInit,
  ProcessRunResult,
  Timer,
  ToastOptions,
  UiPane,
} from 'claude-code'

export type InloopState = PluginState['inloop']

export type StateCell<T> = {
  get: () => Promise<T>
  update: (change: (value: T) => T) => Promise<T>
}

export type Host = {
  root: () => Promise<string>
  /** The person's home folder; '' when unknown. */
  home: () => Promise<string>
  readFile: (path: string) => Promise<string>
  listDir: (path: string) => Promise<FsEntry[]>
  run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
  complete: (request: ModelCompleteRequest, options?: ModelCompleteOptions) => Promise<ModelCompleteResult>
  classify: (text: string, labels: readonly string[], options?: ClassifyOptions) => Promise<string | undefined>
  storeGet: (key: string) => Promise<unknown>
  storeSet: (key: string, value: unknown) => Promise<void>
  /** The session's inloop values: read one, or change it from its current value. */
  state: { [K in keyof InloopState]: StateCell<InloopState[K]> }
  status: (text: string | undefined) => void
  toast: (text: string, options?: ToastOptions) => void
  log: (text: string) => void
  panes: () => Promise<readonly UiPane[]>
  /** Asks for the inloop pane without taking the keyboard (placed only where there is room). */
  openPane: () => Promise<unknown>
  speak: (text: string, voice?: string) => Promise<unknown>
  /** Speaks `text` in a way that can be cut off: `done` settles when it ends or is stopped. */
  /** `rate` is how fast, 1 normal; the platform voice where `say` is missing keeps its own pace. */
  say: (text: string, voice?: string, rate?: number) => { done: Promise<void>; stop: () => void }
  /**
   * Runs inloop's read-only reader agent on a task and resolves with its final
   * message; rejects when it cannot start, fails or takes too long. Absent where
   * agents cannot run (a headless run).
   */
  investigate?: (prompt: string, description: string, model: string) => Promise<string>
  /** Whether `uv` (which runs the Kokoro voice) is on this machine, or in inloop's cache. */
  readonly hasUv: boolean
  /** Fetches uv's own build into inloop's cache (~/.cache/inloop/bin), its checksum checked; `text` says why when it could not. */
  getUv: () => Promise<{ ok: boolean; text: string }>
  /** Whether this machine has a player for Kokoro's clips (afplay, pw-play, paplay, aplay, ffplay, or PowerShell). */
  canPlayClips: boolean
  /** Whether the Kokoro voice is set up (checked offline). */
  kokoroReady: () => Promise<boolean>
  /** Downloads and checks Kokoro once; resolves with what the setup printed. */
  kokoroSetup: () => Promise<{ ok: boolean; text: string }>
  /** Renders `texts` with Kokoro in one process: each WAV path as it is ready, in order. */
  synthesize: (texts: readonly string[], voice: string, speed: number) => { paths: AsyncIterable<string>; stop: () => void }
  /** Plays an audio file with this machine's player; can be cut off. `done` rejects when it could not play. */
  play: (path: string, rate?: number) => { done: Promise<void>; stop: () => void }
  /** Whether this machine's player can play a clip faster or slower (afplay, ffplay); elsewhere Kokoro renders at the speed. */
  playsAtRate: boolean
  /** The system's voice listing (`say -v '?'` on macOS); '' where there is none. */
  listVoices: () => Promise<string>
  after: (ms: number, fn: () => void) => Timer
  every: (ms: number, fn: () => void) => Timer
}
