// Path validation, sensitive-file rules and secret redaction. Pure functions.

const SENSITIVE = [
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)\.envrc$/i,
  /\.(pem|key|p12|pfx|jks|keystore|asc|gpg)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)\.(npmrc|pypirc|netrc|git-credentials|htpasswd)$/i,
  /(^|\/)\.(aws|ssh|gnupg|docker)\//i,
  /(^|\/)(credentials|secrets?)(\.[a-z]+)?$/i,
  /(^|\/)service[-_]?account.*\.json$/i,
  /(^|\/)\.git\//,
]

/** True for files inloop never reads: env files, keys, credentials, git internals. */
export function isSensitive(rel: string): boolean {
  return SENSITIVE.some(re => re.test(rel))
}

const NOISE = [
  /(^|\/)node_modules\//,
  /(^|\/)(dist|build|out|coverage|\.next|\.nuxt|vendor|target|__pycache__|site-packages|\.tox|\.mypy_cache|\.pytest_cache|\.ruff_cache|\.ipynb_checkpoints)\//,
  // Virtual environments by any name: .venv, venv, .venv-qi, my-venv, env/lib/python3.12…
  /(^|\/)[^/]*venv[^/]*\//i,
  /(^|\/)[^/]+\/lib\/python\d[^/]*\//,
  /(^|\/)pyvenv\.cfg$/,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|poetry\.lock|go\.sum)$/,
  /\.(min\.js|map|png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|woff2?|ttf|eot|mp[34]|mov|wasm)$/i,
  /(^|\/)\.claude-plugin\/types\//,
]

/** True for generated, vendored or binary files that are not worth explaining. */
export function isNoise(rel: string): boolean {
  return NOISE.some(re => re.test(rel))
}

/**
 * Turns a path the agent or the person named into a path relative to `root`,
 * or null when it leaves the project, is malformed, or names nothing.
 */
export function toRelative(root: string, path: string): string | null {
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024) return null
  if (path.includes('\0')) return null
  let rest = path.replace(/\\/g, '/')
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '')
  if (rest.startsWith('/')) {
    if (rest === base) return null
    if (!rest.startsWith(base + '/')) return null
    rest = rest.slice(base.length + 1)
  }
  const out: string[] = []
  for (const part of rest.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length === 0) return null
      out.pop()
      continue
    }
    out.push(part)
  }
  return out.length === 0 ? null : out.join('/')
}

/**
 * A git revision safe to hand to git as one argument: no option-looking
 * leading dash, no range syntax, no whitespace.
 */
export function isSafeRev(rev: string): boolean {
  return /^(?!-)[A-Za-z0-9._/~^@{}-]{1,128}$/.test(rev) && !rev.includes('..')
}

/** An approximate date git understands ("3 months ago", "2026-07-01"). */
export function isSafeDate(text: string): boolean {
  return /^(?!-)[A-Za-z0-9 :,._/+-]{1,64}$/.test(text)
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bsk-(ant-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
]

const ASSIGNED_SECRET =
  /((?:api[_-]?key|secret|token|passwd|password|private[_-]?key|access[_-]?key|client[_-]?secret)["']?\s*[:=]\s*)(["'`])([^"'`\n]{8,})\2/gi

/** Masks literal secrets before text leaves the machine or is shown. */
export function redact(text: string): string {
  let out = text
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]')
  out = out.replace(ASSIGNED_SECRET, (_m, lead: string, q: string, value: string) =>
    /^(process\.env|os\.environ|env\.|\$\{)/.test(value) ? `${lead}${q}${value}${q}` : `${lead}${q}[redacted]${q}`,
  )
  return out
}
