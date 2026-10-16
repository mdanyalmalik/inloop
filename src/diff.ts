// A small line diff that writes unified hunks, enough for showing what one
// batch of edits did to a file.

type Op = { kind: ' ' | '-' | '+'; text: string; a: number; b: number }

function lcsOps(a: readonly string[], b: readonly string[]): Op[] | null {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  const n = endA - start
  const m = endB - start
  if (n * m > 2_500_000) return null
  // dp[i][j]: LCS length of a[start+i..endA) and b[start+j..endB)
  const dp: Uint32Array[] = []
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!
    const below = dp[i + 1]!
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[start + i] === b[start + j] ? below[j + 1]! + 1 : Math.max(below[j]!, row[j + 1]!)
    }
  }
  const ops: Op[] = []
  for (let k = 0; k < start; k++) ops.push({ kind: ' ', text: a[k]!, a: k, b: k })
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) {
      ops.push({ kind: ' ', text: a[start + i]!, a: start + i, b: start + j }); i++; j++
    } else if (j < m && (i >= n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) {
      ops.push({ kind: '+', text: b[start + j]!, a: start + i, b: start + j }); j++
    } else {
      ops.push({ kind: '-', text: a[start + i]!, a: start + i, b: start + j }); i++
    }
  }
  for (let k = 0; k < a.length - endA; k++) ops.push({ kind: ' ', text: a[endA + k]!, a: endA + k, b: endB + k })
  return ops
}

/** Unified-diff hunks (no file header) from `before` to `after`, `context` lines around each change. */
export function unifiedDiff(before: string, after: string, context = 3): string {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')
  const ops = lcsOps(a, b)
  if (ops === null) {
    return [`@@ -1,${a.length} +1,${b.length} @@`, ...a.map(l => '-' + l), ...b.map(l => '+' + l)].join('\n')
  }
  const changed = ops.map((op, i) => (op.kind !== ' ' ? i : -1)).filter(i => i >= 0)
  if (changed.length === 0) return ''
  const hunks: string[] = []
  let idx = 0
  while (idx < changed.length) {
    const first = changed[idx]!
    let last = first
    while (idx + 1 < changed.length && changed[idx + 1]! - last <= context * 2 + 1) { idx++; last = changed[idx]! }
    idx++
    const lo = Math.max(0, first - context)
    const hi = Math.min(ops.length - 1, last + context)
    const slice = ops.slice(lo, hi + 1)
    const aStart = (slice.find(o => o.kind !== '+')?.a ?? slice[0]!.a) + 1
    const bStart = (slice.find(o => o.kind !== '-')?.b ?? slice[0]!.b) + 1
    const aLen = slice.filter(o => o.kind !== '+').length
    const bLen = slice.filter(o => o.kind !== '-').length
    hunks.push(`@@ -${aLen === 0 ? aStart - 1 : aStart},${aLen} +${bLen === 0 ? bStart - 1 : bStart},${bLen} @@`)
    for (const op of slice) hunks.push(op.kind + op.text)
  }
  return hunks.join('\n')
}

/** The new-side line numbers a diff adds or changes. */
export function changedLines(diff: string): number[] {
  const out: number[] = []
  let b = 0
  for (const line of diff.split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (h !== null) { b = Number(h[1]); continue }
    if (line.startsWith('+')) { out.push(b); b++ }
    else if (line.startsWith(' ')) b++
  }
  return out
}
