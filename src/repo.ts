// Read-only access to the project: files of the working tree or of any commit,
// search, and the code index. Nothing here writes: working-tree files are read
// through $.fs.read, historical ones out of git's object store, so the person's
// checkout, branch, index and uncommitted work are never touched.

import type { Host } from './host'

import { buildIndex, type CodeIndex, type IndexedFile } from './graph'
import { isSourceFile } from './analysis'
import { isNoise, isSafeDate, isSafeRev, isSensitive, toRelative } from './security'
import { Lru } from './batcher'
import type { InloopCommit } from '../types'

const MAX_INDEX_FILES = 800
const MAX_FILE_BYTES = 400_000

export class RepoError extends Error {}

/** Files and folders that mark a folder as a software project. */
const PROJECT_MARKERS = [
  'package.json', 'pyproject.toml', 'setup.py', 'requirements.txt', 'Pipfile', 'Cargo.toml', 'go.mod', 'Gemfile',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'mix.exs', 'Package.swift', 'CMakeLists.txt',
  'Makefile', 'deno.json', 'tsconfig.json', 'src', 'lib', 'app',
]

/**
 * Why the session's folder is not a project to explain, or null when it is:
 * the home folder or the file system root never are; another folder is when
 * it is a git repository or holds a project file.
 */
export async function notAProject(host: Host, root: string, isGit: boolean): Promise<string | null> {
  const home = (await host.home().catch(() => '')).replace(/\/+$/, '')
  const here = root.replace(/\/+$/, '')
  if (here === '' || here === '/' || (home !== '' && here === home)) {
    return `This Claude Code session is running in ${here === '' ? '/' : here === home ? 'your home folder' : here}, which is not a project, so there is no code here for inloop to explain. Start Claude Code inside a project folder (cd into it first).`
  }
  if (isGit) return null
  const entries = await host.listDir(root).catch(() => [])
  if (entries.some(e => PROJECT_MARKERS.includes(e.name))) return null
  return `${here} does not look like a project (no git repository and no project files such as package.json), so inloop has no code here to explain. Start Claude Code inside a project folder.`
}

export class Repo {
  private files = new Lru<string>(300)
  private indexes = new Lru<CodeIndex>(6)
  private worktreeIndex: CodeIndex | null = null
  private dirty = new Set<string>()

  private constructor(
    private readonly host: Host,
    readonly root: string,
    readonly isGit: boolean,
    /** Null when the session runs in a project; otherwise why it does not. */
    readonly notProject: string | null,
    /** Where the session's folder is inside the repository ('' at its top, else ending in '/'). */
    private readonly prefix = '',
  ) {}

  static async open(host: Host): Promise<Repo> {
    const root = await host.root()
    const probe = await host.run(['git', 'rev-parse', '--is-inside-work-tree'], { cwd: root, timeoutMs: 5000 }).catch(() => undefined)
    const isGit = probe?.exitCode === 0 && probe.stdout.trim() === 'true'
    const where = isGit ? await host.run(['git', 'rev-parse', '--show-prefix'], { cwd: root, timeoutMs: 5000 }).catch(() => undefined) : undefined
    const prefix = where?.exitCode === 0 ? where.stdout.trim() : ''
    return new Repo(host, root, isGit, await notAProject(host, root, isGit), prefix)
  }

  /** Runs git read-only in the project; rejects with git's message on failure. */
  async git(args: readonly string[], timeoutMs = 20_000): Promise<string> {
    if (!this.isGit) throw new RepoError('This project is not a git repository.')
    const r = await this.host.run(['git', '-c', 'core.quotepath=off', '--no-pager', ...args], { cwd: this.root, timeoutMs })
    if (r.exitCode !== 0) throw new RepoError((r.stderr || r.stdout).trim().split('\n')[0] ?? `git ${args[0]} failed`)
    return r.stdout
  }

  rel(path: string): string {
    const rel = toRelative(this.root, path)
    if (rel === null) throw new RepoError(`${path} is outside the project.`)
    if (isSensitive(rel)) throw new RepoError(`${rel} looks like a secrets or credentials file; inloop does not read it.`)
    return rel
  }

  /**
   * Files of the working tree that differ from HEAD, untracked ones included
   * and ignored ones left out: where a change made by any means (a shell
   * command, a script, a formatter) shows up.
   */
  async dirtyFiles(): Promise<string[]> {
    return (await this.dirtyEntries()).map(e => e.path)
  }

  /** Files that differ from HEAD or are untracked (not ignored, noise or secrets), and whether each is deleted. */
  async dirtyEntries(): Promise<{ path: string; isDeleted: boolean }[]> {
    if (!this.isGit || this.notProject !== null) return []
    // Porcelain paths are the repository's even from a subfolder: kept to the session's folder, made relative to it.
    const out = await this.git(['status', '--porcelain', '--no-renames', '-uall', '--', '.'])
    return out
      .split('\n')
      .filter(line => line.length > 3)
      .map(line => ({ path: line.slice(3).replace(/^"(.*)"$/, '$1'), isDeleted: line[0] === 'D' || line[1] === 'D' }))
      .filter(e => e.path.startsWith(this.prefix))
      .map(e => ({ ...e, path: e.path.slice(this.prefix.length) }))
      .filter(e => !isNoise(e.path) && !isSensitive(e.path))
  }

  /** The commit checked out now; undefined without git or before the first commit. */
  async head(): Promise<string | undefined> {
    if (!this.isGit || this.notProject !== null) return undefined
    return (await this.git(['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '')).trim() || undefined
  }

  /** Files that differ between two commits (not noise, not secrets). */
  async changedBetween(from: string, to: string): Promise<string[]> {
    const out = await this.git(['diff', '--name-only', '--no-renames', '--relative', this.checkRev(from), this.checkRev(to), '--'])
    return out.split('\n').filter(p => p !== '' && !isNoise(p) && !isSensitive(p))
  }

  /**
   * A fingerprint of each file's content as it is now, from one `git hash-object`
   * (nothing is written to git): what lets a scan read only the files that changed.
   * A file that is gone has none.
   */
  async fingerprints(paths: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    if (!this.isGit || paths.length === 0) return out
    for (let i = 0; i < paths.length; i += 2000) {
      // Only files that exist: hash-object stops at the first one missing.
      const present = paths.slice(i, i + 2000)
      const r = await this.host.run(['git', 'hash-object', '--no-filters', '--stdin-paths'], { cwd: this.root, timeoutMs: 30_000, stdin: present.join('\n') + '\n' })
      if (r.exitCode !== 0) continue
      r.stdout.trim().split('\n').forEach((h, j) => { if (present[j] !== undefined && h !== '') out.set(present[j]!, h) })
    }
    return out
  }

  /** A working-tree file read afresh (something other than an edit tool may have changed it); null when gone. */
  async readFresh(path: string): Promise<string | null> {
    const rel = this.rel(path)
    this.touch(rel)
    return this.read(rel).catch(() => null)
  }

  /** Marks a working-tree file changed (an edit landed). */
  touch(rel: string): void {
    this.files.delete(`@:${rel}`)
    this.dirty.add(rel)
  }

  async read(path: string, rev?: string): Promise<string> {
    const rel = this.rel(path)
    const key = `${rev ?? '@'}:${rel}`
    const held = this.files.get(key)
    if (held !== undefined) return held
    let text: string
    if (rev !== undefined) {
      if (!isSafeRev(rev)) throw new RepoError(`${rev} is not a revision inloop accepts.`)
      // A path after `rev:` is from the repository's top, wherever git runs.
      text = await this.git(['show', `${rev}:${this.prefix}${rel}`])
    } else {
      try {
        text = await this.host.readFile(`${this.root}/${rel}`)
      } catch (err) {
        throw new RepoError(`Cannot read ${rel}: ${String((err as Error).message ?? err)}`)
      }
    }
    // HEAD moves with each commit the agent makes: its text is read again each time.
    if (rev !== 'HEAD') this.files.set(key, text)
    return text
  }

  async exists(path: string, rev?: string): Promise<boolean> {
    try {
      await this.read(path, rev)
      return true
    } catch {
      return false
    }
  }

  async listFiles(rev?: string): Promise<string[]> {
    // A session in the home folder (or anywhere that is not a project) has no code to explain:
    // never sweep up unrelated folders and explain those instead.
    if (this.notProject !== null) return []
    let names: string[]
    if (this.isGit) {
      const out = rev === undefined
        ? await this.git(['ls-files', '-co', '--exclude-standard'])
        : await this.git(['ls-tree', '-r', '--name-only', this.checkRev(rev)])
      names = out.split('\n').filter(n => n !== '')
    } else {
      names = await this.walk('', 0)
    }
    return names.filter(n => !isNoise(n) && !isSensitive(n))
  }

  private async walk(dir: string, depth: number): Promise<string[]> {
    if (depth > 8) return []
    const out: string[] = []
    const entries = await this.host.listDir(dir === '' ? this.root : `${this.root}/${dir}`).catch(() => [])
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.github') continue
      const rel = dir === '' ? e.name : `${dir}/${e.name}`
      if (isNoise(rel + '/') || isNoise(rel)) continue
      if (e.kind === 'dir') out.push(...(await this.walk(rel, depth + 1)))
      else if (e.kind === 'file') out.push(rel)
      if (out.length > 4000) break
    }
    return out
  }

  checkRev(rev: string): string {
    if (!isSafeRev(rev)) throw new RepoError(`${rev} is not a revision inloop accepts.`)
    return rev
  }

  /** Full sha of a revision, or a RepoError. */
  async resolve(rev: string): Promise<string> {
    return (await this.git(['rev-parse', '--verify', '--quiet', `${this.checkRev(rev)}^{commit}`])).trim()
  }

  /** Lines matching `query` (fixed string, case-insensitive), at `rev` or in the working tree. */
  async grep(query: string, rev?: string, limit = 40): Promise<{ path: string; line: number; text: string }[]> {
    if (query.trim() === '' || query.length > 200) return []
    if (this.isGit) {
      const args = ['grep', '-n', '-I', '-i', '-F', '--no-color', '-e', query]
      if (rev !== undefined) args.push(this.checkRev(rev))
      else args.push('--untracked')
      args.push('--', '.', ':(exclude)*.lock', ':(exclude)package-lock.json', ':(exclude)node_modules', ':(exclude).env*')
      const r = await this.host.run(['git', '--no-pager', ...args], { cwd: this.root, timeoutMs: 15000 })
      if (r.exitCode > 1) throw new RepoError(r.stderr.trim())
      const out: { path: string; line: number; text: string }[] = []
      for (const raw of r.stdout.split('\n')) {
        const row = rev !== undefined ? raw.slice(raw.indexOf(':') + 1) : raw
        const m = /^(.+?):(\d+):(.*)$/.exec(row)
        if (m === null) continue
        const path = m[1]!
        if (isSensitive(path) || isNoise(path)) continue
        out.push({ path, line: Number(m[2]), text: m[3]!.slice(0, 200) })
        if (out.length >= limit) break
      }
      return out
    }
    const index = await this.index()
    const needle = query.toLowerCase()
    const out: { path: string; line: number; text: string }[] = []
    for (const f of index.files.values()) {
      f.lines.forEach((text, i) => {
        if (out.length < limit && text.toLowerCase().includes(needle)) out.push({ path: f.path, line: i + 1, text: text.slice(0, 200) })
      })
    }
    return out
  }

  /** The code index at `rev` (cached; commits never change) or of the working tree. */
  async index(rev?: string): Promise<CodeIndex> {
    if (rev !== undefined) {
      const sha = await this.resolve(rev)
      const held = this.indexes.get(sha)
      if (held !== undefined) return held
      const names = (await this.listFiles(sha)).filter(isSourceFile).slice(0, MAX_INDEX_FILES)
      const files = await this.catFiles(sha, names)
      const index = buildIndex(files, sha)
      this.indexes.set(sha, index)
      return index
    }
    if (this.worktreeIndex !== null && this.dirty.size === 0) return this.worktreeIndex
    if (this.worktreeIndex !== null && this.dirty.size < 20) {
      // Re-read only what changed since the last build.
      const changed = [...this.dirty]
      this.dirty.clear()
      const keep = [...this.worktreeIndex.files.values()]
        .filter(f => !changed.includes(f.path))
        .map(f => ({ path: f.path, text: f.text }))
      const fresh = await this.readMany(changed.filter(isSourceFile))
      this.worktreeIndex = buildIndex([...keep, ...fresh])
      return this.worktreeIndex
    }
    this.dirty.clear()
    const names = (await this.listFiles()).filter(isSourceFile).slice(0, MAX_INDEX_FILES)
    this.worktreeIndex = buildIndex(await this.readMany(names))
    return this.worktreeIndex
  }

  private async readMany(names: readonly string[]): Promise<IndexedFile[]> {
    const out: IndexedFile[] = []
    for (let i = 0; i < names.length; i += 16) {
      const chunk = names.slice(i, i + 16)
      const texts = await Promise.all(chunk.map(n => this.host.readFile(`${this.root}/${n}`).catch(() => null)))
      chunk.forEach((path, j) => {
        const text = texts[j]
        if (typeof text === 'string' && text.length <= MAX_FILE_BYTES) out.push({ path, text })
      })
    }
    return out
  }

  /** Many files of one commit in a single `git cat-file --batch`. */
  private async catFiles(sha: string, names: readonly string[]): Promise<IndexedFile[]> {
    if (names.length === 0) return []
    const r = await this.host.run(['git', 'cat-file', '--batch'], {
      cwd: this.root,
      stdin: names.map(n => `${sha}:${this.prefix}${n}`).join('\n') + '\n',
      timeoutMs: 30_000,
    })
    if (r.exitCode !== 0) throw new RepoError(r.stderr.trim())
    const bytes = new TextEncoder().encode(r.stdout)
    const decoder = new TextDecoder()
    const out: IndexedFile[] = []
    let pos = 0
    for (const name of names) {
      const nl = bytes.indexOf(10, pos)
      if (nl < 0) break
      const header = decoder.decode(bytes.subarray(pos, nl))
      pos = nl + 1
      const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header)
      if (m === null) continue // "<name> missing"
      const size = Number(m[2])
      if (m[1] === 'blob' && size <= MAX_FILE_BYTES) out.push({ path: name, text: decoder.decode(bytes.subarray(pos, pos + size)) })
      pos += size + 1
    }
    return out
  }

  // ---- history ----------------------------------------------------------------

  async log(options: { query?: string; path?: string; limit?: number; range?: [string, string] } = {}): Promise<InloopCommit[]> {
    const args = ['log', '--no-color', '--date=short', '--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s', `-n${Math.min(200, options.limit ?? 40)}`]
    const q = options.query?.trim() ?? ''
    if (options.range !== undefined) args.push(`${this.checkRev(options.range[0])}..${this.checkRev(options.range[1])}`)
    else if (/^[0-9a-f]{4,40}$/i.test(q)) {
      try {
        args.push(await this.resolve(q))
        args.push('-n1')
      } catch {
        args.push(`--grep=${q}`, '-i')
      }
    } else if (q !== '') args.push(`--grep=${q}`, '-i')
    if (options.path !== undefined) args.push('--', this.rel(options.path))
    const out = await this.git(args)
    return out.split('\n').filter(l => l !== '').map(line => {
      const [sha = '', short = '', author = '', date = '', subject = ''] = line.split('\x1f')
      return { sha, short, author, date, subject }
    })
  }

  async commitFiles(sha: string): Promise<{ status: string; path: string }[]> {
    const out = await this.git(['diff-tree', '--no-commit-id', '--root', '-r', '-M', '--name-status', this.checkRev(sha)])
    return out.split('\n').filter(l => l !== '').map(l => {
      const parts = l.split('\t')
      return { status: (parts[0] ?? '?').slice(0, 1), path: parts[parts.length - 1] ?? '' }
    }).filter(f => !isSensitive(f.path))
  }

  async commitMeta(sha: string): Promise<{ sha: string; short: string; author: string; date: string; subject: string; body: string; parent?: string }> {
    const out = await this.git(['show', '-s', '--date=iso', '--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1f%P%x1f%b', this.checkRev(sha)])
    const [full = '', short = '', author = '', date = '', subject = '', parents = '', body = ''] = out.split('\x1f')
    return { sha: full, short, author, date, subject, body: body.trim(), parent: parents.split(' ')[0] || undefined }
  }

  /** The commit's patch, without secrets files, optionally for one path. */
  async commitPatch(sha: string, path?: string, context = 3): Promise<string> {
    const args = ['show', '--no-color', '--format=', `-U${context}`, '-M', this.checkRev(sha), '--', path === undefined ? '.' : this.rel(path), ':(exclude).env*', ':(exclude)*.pem', ':(exclude)*.key']
    return this.git(args)
  }

  async diff(from: string, to: string, paths: readonly string[] = [], stat = false): Promise<string> {
    const args = ['diff', '--no-color', '-M', stat ? '--stat' : '-U3', this.checkRev(from), this.checkRev(to), '--', ...(paths.length > 0 ? paths.map(p => this.rel(p)) : ['.']), ':(exclude).env*']
    return this.git(args)
  }

  /** The last commit at or before an approximate date, or the first commit when none is that old. */
  async revAt(when: string): Promise<{ sha: string; note: string }> {
    if (!isSafeDate(when)) throw new RepoError(`"${when}" is not a date inloop understands.`)
    const sha = (await this.git(['rev-list', '-1', `--before=${when}`, 'HEAD'])).trim()
    if (sha !== '') {
      const meta = await this.commitMeta(sha)
      return { sha, note: `Closest commit at or before "${when}": ${meta.short} (${meta.date.slice(0, 10)}) "${meta.subject}".` }
    }
    const first = (await this.git(['rev-list', '--max-parents=0', 'HEAD'])).trim().split('\n')[0] ?? ''
    if (first === '') throw new RepoError('The repository has no commits.')
    const meta = await this.commitMeta(first)
    return { sha: first, note: `No commit is as old as "${when}"; using the first commit, ${meta.short} (${meta.date.slice(0, 10)}).` }
  }
}
