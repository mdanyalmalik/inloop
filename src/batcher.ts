// Groups edits into development steps: edits to the same files arriving close
// together are one batch, flushed after a quiet spell or a maximum wait.

import type { FileChange } from './analysis'

export type BatchOptions = { quietMs: number; maxWaitMs: number; maxFiles: number }

export class Batcher {
  private files = new Map<string, FileChange>()
  private firstAt = 0
  private lastAt = 0

  constructor(private readonly options: BatchOptions) {}

  get size(): number {
    return this.files.size
  }

  /** Adds one edit; keeps the earliest `before` and the latest `after` per file. */
  add(change: FileChange): void {
    if (this.files.size === 0) this.firstAt = change.at
    this.lastAt = change.at
    const held = this.files.get(change.path)
    if (held === undefined) {
      this.files.set(change.path, { ...change, snippets: [...change.snippets], tools: [...change.tools] })
      return
    }
    held.after = change.after
    held.snippets.push(...change.snippets)
    if (held.snippets.length > 40) held.snippets.splice(0, held.snippets.length - 40)
    for (const t of change.tools) if (!held.tools.includes(t)) held.tools.push(t)
    held.at = change.at
  }

  /** When the batch should be flushed, or null while empty. */
  dueAt(): number | null {
    if (this.files.size === 0) return null
    if (this.files.size >= this.options.maxFiles) return this.lastAt
    return Math.min(this.lastAt + this.options.quietMs, this.firstAt + this.options.maxWaitMs)
  }

  isDue(now: number): boolean {
    const due = this.dueAt()
    return due !== null && now >= due
  }

  take(): FileChange[] {
    const out = [...this.files.values()]
    this.files.clear()
    return out
  }
}

/** FNV-1a over a string: a cheap content key for caches and dedupe. */
export function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** A bounded map that forgets its oldest entries. */
export class Lru<V> {
  private map = new Map<string, V>()
  constructor(private readonly max: number) {}
  get(key: string): V | undefined {
    const v = this.map.get(key)
    if (v !== undefined) { this.map.delete(key); this.map.set(key, v) }
    return v
  }
  set(key: string, value: V): void {
    this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }
  delete(key: string): void {
    this.map.delete(key)
  }
  has(key: string): boolean {
    return this.map.has(key)
  }
  clear(): void {
    this.map.clear()
  }
}
