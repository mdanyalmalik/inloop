// The inloop pane. One tree per draw, built from the session's state; every
// control calls back into the App, never into the project.

import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import type {
  InloopCard,
  InloopContext,
  InloopFlow,
  InloopGitView,
  InloopNarration,
  InloopNav,
  InloopRef,
  InloopSettings,
  InloopStatus,
  InloopStep,
  InloopTab,
  InloopTurn,
  InloopTurnChanges,
  InloopUsage,
  InloopViewer,
} from '../types'
import { type App, RECENT_MINUTES } from './app'
import { extractSymbols } from './analysis'
import { formatRanges, summarizeDiff } from './diff'
import { describePlan, KOKORO_VOICES, NO_PLAYER_HELP, rankVoices, VOICE_HELP } from './voices'
import { callersOf, calleesOf, enclosingSymbol, flowOrder, lookup } from './graph'

export type Snapshot = {
  tab: InloopTab
  status: InloopStatus
  settings: InloopSettings
  ctx: InloopContext
  cards: InloopCard[]
  expanded: string | null
  viewer: InloopViewer | null
  nav: InloopNav[]
  flow: InloopFlow | null
  selected: string | null
  note: string | null
  convo: InloopTurn[]
  askOpen: number | null
  history: InloopCard[]
  git: InloopGitView
  usage: InloopUsage
  narration: InloopNarration | null
  changes: InloopTurnChanges
  frame: number
}

/** What a draw has: the surface's elements, the state as read for this draw, the controller, the room. */
export type Kit = {
  el: Elements[RenderSurface]
  surface: RenderSurface
  s: Snapshot
  app: App
  width: number
  rows: number
}

const TABS: { tab: InloopTab; label: string; short: string; key: string }[] = [
  { tab: 'feed', label: 'Feed', short: 'Feed', key: '1' },
  { tab: 'code', label: 'Code', short: 'Code', key: '2' },
  { tab: 'flow', label: 'Flow', short: 'Flow', key: '3' },
  { tab: 'ask', label: 'Ask', short: 'Ask', key: '4' },
  { tab: 'history', label: 'History', short: 'Hist', key: '5' },
  { tab: 'git', label: 'Git', short: 'Git', key: '6' },
  { tab: 'settings', label: 'Settings', short: 'Settings', key: '7' },
]

/** Below this many columns (the default dock) the pane drops what does not fit. */
const isNarrow = (k: Kit) => k.width < 60

/** Surfaces that draw text fields and pickers (mobile draws neither yet). */
const hasFields = (k: Kit) => k.surface !== 'mobile'
/** Surfaces that draw SVG (every one but the terminal). */
const hasSvg = (k: Kit) => k.surface !== 'terminal'

/** Node kinds that are definitions in this repository (the rest are libraries, databases, URLs). */
const IN_REPO = ['function', 'method', 'class', 'component', 'route', 'handler']

const CONF_MARK: Record<string, string> = { confirmed: '━', inferred: '┅', runtime: '┈' }

/**
 * A handler for a control that starts long work (a model call, speech): the
 * work runs on the plugin's own timer, so the press answers at once and no
 * time limit on the press can cut the work short.
 */
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
/** The spinner glyph for this frame. */
const spin = (frame: number) => SPIN[frame % SPIN.length]!

const fire = (k: Kit, work: () => Promise<unknown>) => (): void => {
  k.app.detach(work)
}

/** Code for display: a blank line is kept as a space, so the line numbers after it stay true. */
const keepBlank = (code: string) => code.split('\n').map(l => (l === '' ? ' ' : l)).join('\n')

/** One part of an explanation: what it says, where the code is, and the code itself. */
function stepView(k: Kit, step: InloopStep, key: string, maxLines: number): RenderElement {
  const { Box, Text, Button, Code, Markdown } = k.el
  const lines = step.code?.split('\n') ?? []
  const where = `${step.ref.path}${step.ref.line !== undefined ? `:${step.ref.line}` : ''}${step.ref.rev !== undefined ? ` @${step.ref.rev.slice(0, 7)}` : ''}`
  return (
    <Box key={key} flexDirection="column" marginTop={1}>
      <Markdown text={step.text} />
      <Button key={`${key}:open`} plain onPress={() => k.app.openRef(step.ref)}>
        <Text dimColor>↗ {where}</Text>
      </Button>
      {lines.length > 0 && (
        <Code source={keepBlank(lines.slice(0, maxLines).join('\n'))} path={step.ref.path} startLine={step.codeStart ?? step.ref.line ?? 1} wrap="truncate-end" />
      )}
      {lines.length > maxLines && <Text dimColor>… {lines.length - maxLines} more lines (open to see all)</Text>}
    </Box>
  )
}

/**
 * Spoken style, above the prompt: what the pane would show while it is hidden
 * (behind another panel, or closed), kept to a few rows.
 */
export function narrationBand(el: Kit['el'], n: InloopNarration, app: App, columns: number, maxRows: number, frame = 0): RenderElement {
  const { Box, Text, Button, Code } = el
  const step = n.steps[Math.max(0, n.index)]
  const codeRows = Math.max(0, Math.min(6, maxRows - 4))
  const lines = (step?.code?.split('\n') ?? []).slice(0, codeRows)
  return (
    <Box flexDirection="column" width={columns}>
      <Box flexDirection="row" columnGap={1}>
        <Text color="suggestion" weight="bold" wrap="truncate-end">{n.isEnded === true ? '■' : n.isPaused ? '⏸' : n.isPreparing === true ? spin(frame) : '▶'} inloop: {n.title}</Text>
        <Text dimColor>{n.isEnded === true ? 'finished' : n.index < 0 ? '' : `${n.index + 1}/${n.steps.length}`}</Text>
        {n.isPreparing === true && !n.isPaused && <Text color="warning">generating audio…</Text>}
      </Box>
      {n.index >= 0 && step !== undefined && <Text wrap="truncate-end">{step.text.replace(/`/g, '')}</Text>}
      {lines.length > 0 && step !== undefined && (
        <Code source={keepBlank(lines.join('\n'))} path={step.ref.path} startLine={step.codeStart ?? step.ref.line ?? 1} wrap="truncate-end" />
      )}
      <Box flexDirection="row" columnGap={1}>
        {n.isEnded === true ? (
          <Box flexDirection="row" columnGap={1}>
            <Button key="band:replay" label="↻ replay" plain onPress={() => app.narrationReplay()} />
            <Button key="band:close" label="✕ close" plain onPress={() => void app.narrationClose()} />
          </Box>
        ) : (
          <Box flexDirection="row" columnGap={1}>
            <Button key="band:prev" label="⏮" plain onPress={() => app.narrationPrev()} />
            {n.isPaused
              ? <Button key="band:resume" label="▶ resume" plain onPress={() => app.narrationResume()} />
              : <Button key="band:pause" label="⏸ pause" plain onPress={() => app.narrationPause()} />}
            <Button key="band:next" label="⏭" plain onPress={() => app.narrationNext()} />
            <Button key="band:stop" label="■ stop" plain onPress={() => app.narrationStop()} />
            <Button key="band:close" label="✕" plain onPress={() => void app.narrationClose()} />
          </Box>
        )}
        <Text dimColor>{step !== undefined && step.ref.path !== '' ? ` ${step.ref.path}` : ''}</Text>
      </Box>
    </Box>
  )
}

/** Spoken style: the part being read aloud, with its code, and the controls. */
function narrationBox(k: Kit): RenderElement | null {
  const n = k.s.narration
  if (n === null) return null
  const app = k.app
  const { Box, Text, Button, Code, Markdown } = k.el
  const step = n.steps[Math.max(0, n.index)]
  const lines = step?.code?.split('\n') ?? []
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="suggestion" paddingX={1}>
      <Text color="suggestion" weight="bold" wrap="truncate-end">{n.isEnded === true ? '■ ' : n.isPaused ? '⏸ ' : n.isPreparing === true ? `${spin(k.s.frame)} ` : '▶ '}{n.title}</Text>
      <Text dimColor>
        {n.isEnded === true ? `finished · back at part 1 of ${n.steps.length}` : n.index < 0 ? 'starting' : `part ${n.index + 1} of ${n.steps.length}`}
        {n.queued > 0 ? ` · ${n.queued} more waiting` : ''}
      </Text>
      {n.isPreparing === true && !n.isPaused && <Text color="warning">{spin(k.s.frame)} generating audio… it plays as soon as it is ready</Text>}
      {n.index >= 0 && step !== undefined && <Markdown text={step.text} />}
      {step !== undefined && step.ref.path !== '' && (
        <Text dimColor wrap="truncate-start">{step.ref.path}{step.ref.line !== undefined ? `:${step.ref.line}` : ''}</Text>
      )}
      {lines.length > 0 && (
        <Code source={keepBlank(lines.slice(0, 18).join('\n'))} path={step!.ref.path} startLine={step!.codeStart ?? step!.ref.line ?? 1} wrap="truncate-end" />
      )}
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {n.isEnded === true ? (
          <Box flexDirection="row" columnGap={1}>
            <Button key="say:replay" label="↻ replay" onPress={() => app.narrationReplay()} />
            <Button key="say:close" label="✕ close" onPress={() => void app.narrationClose()} />
          </Box>
        ) : (
          <Box flexDirection="row" columnGap={1}>
            <Button key="say:prev" label="⏮" onPress={() => app.narrationPrev()} />
            {n.isPaused
              ? <Button key="say:resume" label="▶ resume" onPress={() => app.narrationResume()} />
              : <Button key="say:pause" label="⏸ pause" onPress={() => app.narrationPause()} />}
            <Button key="say:next" label="⏭" onPress={() => app.narrationNext()} />
            <Button key="say:stop" label="■ stop" onPress={() => app.narrationStop()} />
            <Button key="say:close" label="✕" onPress={() => void app.narrationClose()} />
          </Box>
        )}
      </Box>
    </Box>
  )
}

export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

function refLabel(r: InloopRef): string {
  const where = `${r.path}${r.line !== undefined ? ':' + r.line : ''}${r.endLine !== undefined && r.endLine !== r.line ? '-' + r.endLine : ''}`
  return `${where}${r.rev !== undefined ? ' @' + r.rev.slice(0, 7) : ''}${r.label !== undefined && r.label !== r.path ? ' — ' + r.label : ''}`
}

export async function renderPane(k: Kit): Promise<RenderElement> {
  const app = k.app
  const table = k.el
  const { Box, Text, Button, Markdown } = table
  const Input = hasFields(k) && 'Input' in table ? table.Input : undefined
  const width = Math.max(30, k.width)
  const tab = k.s.tab
  const status = k.s.status
  const settings = k.s.settings
  const ctx = k.s.ctx

  const narrow = isNarrow(k)
  const header = (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
      {TABS.map(t => (
        <Button key={`tab:${t.tab}`} hotkey={narrow ? undefined : t.key} plain onPress={() => app.setTab(t.tab)}>
          <Text inverse={t.tab === tab} weight={t.tab === tab ? 'bold' : undefined}>{k.width < 72 ? t.short : t.label}</Text>
        </Button>
      ))}
    </Box>
  )

  const mode = settings.mode === 'focus' ? `focus: ${settings.focus || '(no topic)'}` : settings.mode
  const statusLine = (
    <Box flexDirection="column">
      <Text dimColor wrap="truncate-end">
        {mode} · {settings.depth}
        {status.pendingChanges > 0 ? ' · watching edits' : ''}
        {status.queued > 0 ? ` · ${status.queued} queued` : ''}
      </Text>
      {ctx.rev !== undefined && (
        <Box flexDirection="row" columnGap={1}>
          <Text color="warning" wrap="truncate-end">studying {ctx.rev.slice(0, 7)}</Text>
          <Button key="rev:working" label="use current code" plain onPress={() => app.studyRevision('working')} />
        </Box>
      )}
      {status.busy !== null && tab !== 'ask' && <Text color="suggestion">{spin(k.s.frame)} {status.busy}</Text>}
      {status.isPreparingAudio === true && k.s.narration === null && <Text color="warning">{spin(k.s.frame)} generating audio…</Text>}
      {status.isVoiceSettingUp === true && (
        <Text dimColor wrap="truncate-end">{spin(k.s.frame)} downloading the natural voice (one time, ~200 MB); the Mac voice speaks until it is ready</Text>
      )}
      {status.lastError !== undefined && status.busy === null && (
        <Box flexDirection="row" columnGap={1}>
          <Text color="error" wrap="truncate-end">! {status.lastError}</Text>
          <Button key="err:dismiss" label="✕" plain onPress={() => app.dismissError()} />
        </Box>
      )}
    </Box>
  )

  let body: RenderElement
  switch (tab) {
    case 'code':
      body = await codeTab(k, width)
      break
    case 'flow':
      body = await flowTab(k)
      break
    case 'ask':
      body = await askTab(k)
      break
    case 'history':
      body = await historyTab(k)
      break
    case 'git':
      body = await gitTab(k)
      break
    case 'settings':
      body = await settingsTab(k)
      break
    default:
      body = await feedTab(k)
  }

  const contextLine = ctx.path !== undefined || ctx.scope !== undefined
    ? (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {ctx.path !== undefined && (
          <Text dimColor wrap="truncate-end">
            about: {ctx.path}:{ctx.line ?? 1}{ctx.symbol !== undefined ? ` ${ctx.symbol}()` : ''}
          </Text>
        )}
        {ctx.scope !== undefined && <Text color="warning">scope: {ctx.scope}</Text>}
        {ctx.scope !== undefined && <Button key="scope:clear" label="clear scope" plain onPress={() => app.clearScope()} />}
      </Box>
    )
    : null

  return (
    <Box flexDirection="column" width={width}>
      {turnChangesView(k)}
      {header}
      {statusLine}
      {narrationBox(k)}
      <Box flexDirection="column" marginTop={1}>{body}</Box>
      <Box flexDirection="column" marginTop={1}>
        {contextLine}
        {Input !== undefined && (
          <Input
            key="ask"
            placeholder="Ask about the code…"
            submitLabel="ask"
            onSubmit={(value: string) => {
              const q = value.trim()
              if (q === '') return
              const kind = /^(show|trace|follow|walk)\b.*\b(flow|happens|path|goes)\b|what happens when/i.test(q) ? 'flow' : 'question'
              app.detach(async () => {
                await app.setTab('ask')
                await app.ask(q, kind)
              })
            }}
          />
        )}
        {Input === undefined && <Markdown text="Use `/inloop <question>` to ask." dimColor />}
      </Box>
    </Box>
  )
}

// ---------------------------------------------------------------------------

/**
 * The files a change touched: each path, lines added and removed, and the
 * line ranges changed; a press opens that file's diff in the Code tab.
 */
const STRIP_FILES = 5

/** The strip over the tabs: every file changed since the person's last prompt, net, each opening its diff. */
function turnChangesView(k: Kit): RenderElement {
  const { Box, Text, Button } = k.el
  const { since, files } = k.s.changes
  const added = files.reduce((n, f) => n + f.added, 0)
  const removed = files.reduce((n, f) => n + f.removed, 0)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={files.length > 0 ? 'suggestion' : undefined} borderDimColor={files.length === 0} paddingX={1} marginBottom={1}>
      <Box flexDirection="row" columnGap={1}>
        <Text weight="bold" wrap="truncate-end">{since === 0 ? 'Changes' : 'Since your last prompt'}</Text>
        {files.length > 0 && (
          <Text dimColor wrap="truncate-end">
            {files.length} file{files.length === 1 ? '' : 's'}
            <Text color="success"> +{added}</Text>
            <Text color="error"> −{removed}</Text>
          </Text>
        )}
      </Box>
      {files.length === 0 && (
        <Text dimColor wrap="truncate-end">{since === 0 ? 'Files changed after your next prompt show here.' : 'No files changed yet.'}</Text>
      )}
      {files.slice(0, STRIP_FILES).map((f, i) => (
        <Button
          key={`strip:${i}:${f.path}`}
          plain
          onPress={() => k.app.openRef({ path: f.path, line: f.ranges[0]?.[0] ?? 1 }, { diff: f.hunks === '' ? undefined : f.hunks, note: `${f.path} since your last prompt` })}
        >
          {f.isNew === true && <Text color="success">new </Text>}
          {f.isDeleted === true && <Text color="error">deleted </Text>}
          <Text wrap="truncate-start">{f.path}</Text>
          <Text color="success"> +{f.added}</Text>
          <Text color="error"> −{f.removed}</Text>
          {f.ranges.length > 0 && f.isDeleted !== true && <Text dimColor>  lines {formatRanges(f.ranges)}</Text>}
        </Button>
      ))}
      {files.length > STRIP_FILES && <Text dimColor>… {files.length - STRIP_FILES} more files</Text>}
    </Box>
  )
}

function changesView(k: Kit, card: InloopCard, list: string): RenderElement | null {
  if (!['auto', 'recent', 'commit', 'compare'].includes(card.source)) return null
  const read = summarizeDiff(card.diff ?? '')
  // A commit or comparison lists every file it changed, read or not; a file not read opens its own diff.
  const files = card.fileStats !== undefined
    ? card.fileStats.map(f => read.find(r => r.path === f.path) ?? { path: f.path, added: f.added, removed: f.removed, ranges: [] as [number, number][], hunks: '' })
    : read
  if (files.length === 0) return null
  const { Box, Text, Button } = k.el
  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} marginBottom={1}>
      <Text dimColor>changes</Text>
      {files.slice(0, 30).map((f, i) => (
        <Button
          key={`${list}:chg:${card.id}:${i}`}
          plain
          onPress={() => f.hunks === '' && card.rev !== undefined && card.source === 'commit'
            ? k.app.openCommitFile(card.rev, f.path, true)
            : k.app.openRef({ path: f.path, line: f.ranges[0]?.[0] ?? 1, rev: card.rev }, { diff: f.hunks || undefined, note: `${f.path} in "${card.title}"` })}
        >
          <Text wrap="truncate-start">{f.path}</Text>
          <Text color="success"> +{f.added}</Text>
          <Text color="error"> −{f.removed}</Text>
          {f.ranges.length > 0 && <Text dimColor>  lines {formatRanges(f.ranges)}</Text>}
        </Button>
      ))}
      {files.length > 30 && <Text dimColor>… {files.length - 30} more files</Text>}
    </Box>
  )
}

/** A change inloop did not explain, or could not: one line that says so, its changes when opened, and the way to get the explanation. */
function unexplainedView(k: Kit, card: InloopCard, isOpen: boolean, list: 'feed' | 'history'): RenderElement {
  const app = k.app
  const { Box, Text, Button } = k.el
  const isFailed = card.failed !== undefined
  return (
    <Box key={`${list}:${card.id}`} flexDirection="column" marginBottom={isOpen ? 1 : 0}>
      <Button key={`${list}:card:${card.id}`} plain onPress={() => app.host.state.expanded.update(cur => (cur === card.id ? null : card.id))}>
        <Text dimColor={!isFailed} color={isFailed ? 'warning' : undefined} wrap="truncate-end">
          {isOpen ? '▾ ' : '▸ '}{isFailed ? '⚠ explanation failed' : 'not explained'} · {card.title}
        </Text>
        <Text dimColor> · {ago(card.at)}</Text>
      </Button>
      <Box paddingLeft={2}>
        <Button key={`${list}:again:${card.id}`} label={isFailed ? 'try again' : 'explain anyway'} plain onPress={fire(k, () => app.explainAgain(card.id))} />
      </Box>
      {isOpen && (
        <Box flexDirection="column" paddingLeft={2}>
          <Text dimColor wrap="wrap">{isFailed ? `The model call failed (${card.failed}). The changes are below; try again for the explanation.` : `Skipped: ${card.skipped}. The changes are below.`}</Text>
          {changesView(k, card, list)}
        </Box>
      )}
    </Box>
  )
}

function cardView(k: Kit, card: InloopCard, isOpen: boolean, list: 'feed' | 'history'): RenderElement {
  if (card.skipped !== undefined || card.failed !== undefined) return unexplainedView(k, card, isOpen, list)
  const app = k.app
  const { Box, Text, Button, Markdown } = k.el
  const tag = card.source === 'auto' ? '' : `${card.source} · `
  return (
    <Box key={`${list}:${card.id}`} flexDirection="column" marginBottom={isOpen ? 1 : 0}>
      <Button key={`${list}:card:${card.id}`} plain onPress={() => app.host.state.expanded.update(cur => (cur === card.id ? null : card.id))}>
        {isOpen ? '▾ ' : '▸ '}
        {card.bookmarked === true ? '★ ' : ''}
        {card.title}
        <Text dimColor>
          {' '}· {tag}{ago(card.at)}{card.isHeuristic === true ? ' · static' : ''}
        </Text>
      </Button>
      {isOpen && (
        <Box flexDirection="column" paddingLeft={2}>
          {card.concept !== undefined && <Text color="suggestion">concept: {card.concept}</Text>}
          {changesView(k, card, list)}
          <Markdown text={card.summary} />
          {(card.steps ?? []).map((step, i) => stepView(k, step, `${list}:step:${card.id}:${i}`, 12))}
          {(card.steps ?? []).length === 0 && card.refs.slice(0, 8).map((r, i) => (
            <Button key={`${list}:ref:${card.id}:${i}`} plain onPress={() => app.openRef(r)}>
              ↗ {refLabel(r)}
            </Button>
          ))}
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Button key={`${list}:bm:${card.id}`} label={card.bookmarked === true ? '★ bookmarked' : '☆ bookmark'} onPress={() => app.toggleBookmark(card.id)} />
            <Button
              key={`${list}:deeper:${card.id}`}
              label="go deeper"
              onPress={fire(k, async () => {
                const first = card.refs[0]
                if (first !== undefined) await app.openRef(first, { switchTab: false })
                await app.setTab('ask')
                await app.ask(`Go deeper on "${card.title}": explain how this works, following the code it touches.${card.rev !== undefined ? ` (This is about revision ${card.rev.slice(0, 10)}.)` : ''}`, 'question', `deeper: ${card.title}`)
              })}
            />
            {card.diff !== undefined && card.diff !== '' && (
              <Button
                key={`${list}:diff:${card.id}`}
                label="diff"
                onPress={() => {
                  const first = card.refs[0] ?? { path: card.files[0] ?? '', line: 1 }
                  return app.openRef({ ...first, rev: card.rev }, { diff: card.diff, note: card.title })
                }}
              />
            )}
            <Button
              key={`${list}:flow:${card.id}`}
              label="flow"
              onPress={fire(k, async () => {
                const sym = card.symbols[0]
                await app.setTab('flow')
                await app.ask(sym !== undefined ? `Show the flow through ${sym}: what calls it and what it calls.` : `Show the flow behind: ${card.title}`, 'flow', `flow: ${card.title}`)
              })}
            />
            <Button key={`${list}:say:${card.id}`} label="▶ listen" onPress={fire(k, () => app.narrate(card, true))} />
            {list === 'history' && <Button key={`history:delete:${card.id}`} label="✕ delete" onPress={() => app.deleteExplanation(card.id)} />}
          </Box>
        </Box>
      )}
    </Box>
  )
}

function feedCount(cards: readonly InloopCard[]): string {
  const shown = cards.filter(c => c.skipped === undefined && c.failed === undefined).length
  const skipped = cards.filter(c => c.skipped !== undefined).length
  const failed = cards.filter(c => c.failed !== undefined).length
  return [`${shown} ${shown === 1 ? 'explanation' : 'explanations'}`, skipped > 0 ? `${skipped} not explained` : '', failed > 0 ? `${failed} failed` : ''].filter(Boolean).join(' · ')
}

async function feedTab(k: Kit): Promise<RenderElement> {
  const app = k.app
  const { Box, Text, Button, Markdown } = k.el
  const cards = k.s.cards
  const expanded = k.s.expanded
  const settings = k.s.settings
  const status = k.s.status
  if (cards.length === 0) {
    const how = settings.mode === 'paused'
      ? 'Automatic explanations are **paused**. Questions still work.'
      : settings.mode === 'ask'
        ? 'Ask mode: edits are recorded but explained only when you ask (try **explain recent**).'
        : settings.mode === 'focus'
          ? `Focus mode: only changes about **${settings.focus || '(set a topic in Settings)'}** get explained.`
          : 'As the coding agent edits files, each meaningful step appears here with a short explanation.'
    return (
      <Box flexDirection="column">
        <Markdown text={`${how}\n\nAsk anything below — e.g. *"what happens when I click Login?"*, *"only explain how tokens are created"*, or open **Git** to study an older commit.`} />
        {status.recentBatches > 0 && (
          <Button key="feed:recent" label={`explain recent changes (${status.recentBatches} steps)`} onPress={fire(k, () => app.explainRecent(RECENT_MINUTES))} />
        )}
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        <Text dimColor>{feedCount(cards)}, newest first</Text>
        {status.recentBatches > 0 && settings.mode !== 'auto' && (
          <Button key="feed:recent" label="explain recent" plain onPress={fire(k, () => app.explainRecent(RECENT_MINUTES))} />
        )}
      </Box>
      {cards.slice(0, 25).map((card, i, shown) => {
        const isFirstEarlier = card.at < app.startedAt && (i === 0 || shown[i - 1]!.at >= app.startedAt)
        return (
          <Box key={`feed:wrap:${card.id}`} flexDirection="column">
            {isFirstEarlier && <Text dimColor>── earlier sessions ──</Text>}
            {cardView(k, card, card.id === expanded, 'feed')}
          </Box>
        )
      })}
    </Box>
  )
}

// ---------------------------------------------------------------------------

async function codeTab(k: Kit, width: number): Promise<RenderElement> {
  const app = k.app
  const { Box, Text, Button, Code, Markdown } = k.el
  const viewer = k.s.viewer
  if (viewer === null) {
    return <Markdown text="Nothing open yet. Press a **↗ code** link on an explanation, a node in **Flow**, or a file in **Git**." />
  }
  const rows = Math.max(12, Math.min(60, k.rows - 16))
  const where = viewer.rev === undefined ? 'working tree' : `commit ${viewer.rev.slice(0, 10)} (historical, read-only)`
  const nav = (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
      {k.s.nav.length > 0 && <Button key="code:prev" label="◀ previous" onPress={() => app.back()} />}
      <Button key="code:up" label="▲" onPress={() => app.scroll(-Math.floor(rows / 2), rows)} />
      <Button key="code:down" label="▼" onPress={() => app.scroll(Math.floor(rows / 2), rows)} />
      {viewer.diff !== undefined && (
        <Button key="code:source" label="show file" onPress={() => app.host.state.viewer.update(v => (v === null ? v : { ...v, diff: undefined }))} />
      )}
      <Button
        key="code:ask"
        label={viewer.diff !== undefined ? 'explain this change' : 'explain these lines'}
        onPress={fire(k, async () => {
          await app.setTab('ask')
          await app.ask(viewer.diff !== undefined
            ? `Explain this change to ${viewer.path}${viewer.rev !== undefined ? ` in commit ${viewer.rev.slice(0, 10)}` : ''}: what it does and how the code behaves differently.`
            : `Explain lines ${viewer.line}-${viewer.endLine} of ${viewer.path}${viewer.rev !== undefined ? ' at this revision' : ''}: what they do and why.`,
            'question', `${viewer.path.split('/').pop()}, lines ${viewer.line}-${viewer.endLine}`)
        })}
      />
    </Box>
  )
  const head = (
    <Box flexDirection="column">
      <Text weight="bold" wrap="truncate-start">{viewer.path}</Text>
      <Text dimColor>{where}{viewer.diff !== undefined ? ' · diff' : ` · lines ${viewer.line}${viewer.endLine !== viewer.line ? `-${viewer.endLine}` : ''}`}</Text>
      {viewer.note !== undefined && <Text color="suggestion" wrap="truncate-end">{viewer.note}</Text>}
    </Box>
  )
  if (viewer.diff !== undefined) {
    return (
      <Box flexDirection="column">
        {head}
        {nav}
        <Code source={viewer.diff.split('\n').slice(0, 400).join('\n')} format="diff" path={viewer.path} wrap="truncate-end" />
      </Box>
    )
  }
  let text: string
  try {
    text = await app.repo.read(viewer.path, viewer.rev)
  } catch (err) {
    return (
      <Box flexDirection="column">
        {head}
        {nav}
        <Text color="error">{String((err as Error).message ?? err)}</Text>
      </Box>
    )
  }
  const lines = text.split('\n')
  const top = Math.min(Math.max(1, viewer.top), Math.max(1, lines.length - 3))
  const bottom = Math.min(lines.length, top + rows - 1)
  const hlFrom = Math.max(top, viewer.line)
  const hlTo = Math.min(bottom, viewer.endLine)
  // A blank line at the end of a block is not drawn: keep it as a space so line numbers stay true.
  const slice = (a: number, b: number) => lines.slice(a - 1, b).map(l => (l === '' ? ' ' : l)).join('\n')
  const symbols = extractSymbols(text, viewer.path).filter(s => s.kind !== 'route' || s.endLine > s.line).slice(0, 40)
  const index = await app.repo.index(viewer.rev).catch(() => null)
  const current = index === null ? undefined : enclosingSymbol(index, viewer.path, viewer.line)
  const sym = current === undefined || index === null ? undefined : lookup(index, current.name, viewer.path)
  const callers = sym !== undefined && index !== null && index.symbols.length < 4000 ? callersOf(index, sym).slice(0, 6) : []
  const callees = sym !== undefined && index !== null ? calleesOf(index, sym).filter(x => !('external' in x.to)).slice(0, 8) : []
  return (
    <Box flexDirection="column">
      {head}
      {nav}
      {hlFrom > top && <Code source={slice(top, hlFrom - 1)} path={viewer.path} startLine={top} wrap="truncate-end" />}
      {hlFrom <= hlTo && (
        <Box borderStyle="quote" borderColor="suggestion">
          <Code source={slice(hlFrom, hlTo)} path={viewer.path} startLine={hlFrom} wrap="truncate-end" />
        </Box>
      )}
      {Math.max(top, hlTo + 1) <= bottom && (
        <Code source={slice(Math.max(top, hlTo + 1), bottom)} path={viewer.path} startLine={Math.max(top, hlTo + 1)} wrap="truncate-end" />
      )}
      <Text dimColor>lines {top}-{bottom} of {lines.length}</Text>
      {sym !== undefined && (
        <Box flexDirection="column" marginTop={1}>
          <Text weight="bold">{sym.name}() <Text dimColor>{sym.kind}{sym.isAsync === true ? ', async' : ''} · lines {sym.line}-{sym.endLine}</Text></Text>
          <Text dimColor>called from:{callers.length === 0 ? ' nothing found in the index' : ''}</Text>
          {callers.map((c, i) => (
            <Button key={`code:caller:${i}`} plain onPress={() => app.openRef({ path: c.from.path, line: c.line, rev: viewer.rev, symbol: c.from.name })}>
              ← {c.from.name}() <Text dimColor>{c.from.path}:{c.line} · {c.confidence}</Text>
            </Button>
          ))}
          <Text dimColor>calls:{callees.length === 0 ? ' nothing in this repository' : ''}</Text>
          {callees.map((c, i) => 'external' in c.to ? null : (
            <Button key={`code:callee:${i}`} plain onPress={() => 'external' in c.to ? undefined : app.openRef({ path: c.to.path, line: c.to.line, endLine: c.to.endLine, rev: viewer.rev, symbol: c.to.name })}>
              → {c.to.name}() <Text dimColor>{c.to.path}:{c.to.line} · {c.confidence}</Text>
            </Button>
          ))}
        </Box>
      )}
      {symbols.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>in this file:</Text>
          <Box flexDirection="row" flexWrap="wrap" columnGap={1} width={width}>
            {symbols.map(s => (
              <Button key={`code:sym:${s.line}:${s.name}`} plain onPress={() => jumpTo(app, s.line, s.endLine)}>
                {s.name === sym?.name ? '●' : '·'}{s.name}<Text dimColor>:{s.line}</Text>
              </Button>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  )
}

async function jumpTo(app: App, line: number, endLine: number): Promise<void> {
  await app.selectLines(line, endLine)
}

// ---------------------------------------------------------------------------

function flowSvg(flow: InloopFlow, selected: string | null): string {
  const byDepth = new Map<number, typeof flow.nodes>()
  for (const n of flow.nodes) byDepth.set(n.depth, [...(byDepth.get(n.depth) ?? []), n])
  const pos = new Map<string, { x: number; y: number }>()
  const colW = 220
  const rowH = 54
  let maxRows = 0
  for (const [d, nodes] of byDepth) {
    nodes.forEach((n, i) => pos.set(n.id, { x: 20 + d * colW, y: 20 + i * rowH }))
    maxRows = Math.max(maxRows, nodes.length)
  }
  const w = 40 + (Math.max(...byDepth.keys(), 0) + 1) * colW
  const h = 40 + maxRows * rowH
  const esc = (s: string) => s.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] ?? c)
  const edges = flow.edges.map(ed => {
    const a = pos.get(ed.from)
    const b = pos.get(ed.to)
    if (a === undefined || b === undefined) return ''
    const dash = ed.confidence === 'confirmed' ? '' : ed.confidence === 'inferred' ? ' stroke-dasharray="6 4"' : ' stroke-dasharray="2 4"'
    return `<line x1="${a.x + 180}" y1="${a.y + 16}" x2="${b.x}" y2="${b.y + 16}" stroke="#8a8f98"${dash} marker-end="url(#arr)"><title>${esc(ed.confidence + ': ' + ed.label)}</title></line>`
  }).join('')
  const nodes = flow.nodes.map(n => {
    const p = pos.get(n.id)!
    const fill = n.id === selected ? '#2f6feb' : ['database', 'library', 'http'].includes(n.kind) ? '#3a3f47' : '#22272e'
    return `<g><rect x="${p.x}" y="${p.y}" width="180" height="32" rx="6" fill="${fill}" stroke="#57606a"/><text x="${p.x + 8}" y="${p.y + 20}" fill="#e6edf3" font-family="ui-monospace,monospace" font-size="12">${esc(n.label.slice(0, 24))}</text><title>${esc(n.ref ? `${n.ref.path}:${n.ref.line ?? ''}` : n.kind)}</title></g>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><marker id="arr" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#8a8f98"/></marker></defs>${edges}${nodes}</svg>`
}

async function flowTab(k: Kit): Promise<RenderElement> {
  const app = k.app
  const table = k.el
  const { Box, Text, Button, Markdown } = table
  const Input = hasFields(k) && 'Input' in table ? table.Input : undefined
  const Svg = hasSvg(k) && 'Svg' in table ? table.Svg : undefined
  const flow = k.s.flow
  const selected = k.s.selected
  const note = k.s.note
  const traceInput = Input !== undefined && (
    <Input
      key="flowq"
      placeholder="Trace a feature… (e.g. what happens when a user logs in)"
      submitLabel="trace"
      onSubmit={(value: string) => {
        const q = value.trim()
        if (q !== '') app.detach(() => app.ask(q, 'flow'))
      }}
    />
  )
  if (flow === null) {
    return (
      <Box flexDirection="column">
        <Markdown text="No flow yet. Describe a feature and inloop traces it through the code: every step is a real definition, and every link says how it is known." />
        {traceInput}
      </Box>
    )
  }
  const label = new Map(flow.nodes.map(n => [n.id, n.label]))
  const order = flowOrder(flow)
  const picked = order.find(o => o.node.id === selected)
  return (
    <Box flexDirection="column">
      <Text weight="bold" wrap="truncate-end">{flow.title}</Text>
      <Text dimColor>
        {flow.rev !== undefined ? `at ${flow.rev.slice(0, 10)} · ` : 'working tree · '}
        {flow.nodes.length} steps · press one to see it
      </Text>
      <Text dimColor>━ confirmed  ┅ inferred  ┈ runtime only</Text>
      {Svg !== undefined && flow.nodes.length > 0 && (
        <Svg source={flowSvg(flow, selected)} alt={`Flow diagram: ${flow.nodes.map(n => n.label).join(' → ')}`} isInteractive />
      )}
      <Box flexDirection="column" marginTop={1}>
        {order.map(({ node: n, depth, via }) => {
          const mark = via === undefined ? '◆' : CONF_MARK[via.confidence] ?? '─'
          return (
            <Button key={`node:${n.id}`} plain onPress={fire(k, () => app.selectNode(n.id))}>
              {'  '.repeat(Math.min(depth, 8))}
              {depth > 0 ? `└${mark} ` : ''}
              {n.id === selected ? '● ' : ''}
              {n.label}
              {!isNarrow(k) && (
                <Text dimColor>
                  {n.ref !== undefined && IN_REPO.includes(n.kind) ? `  ${n.ref.path}:${n.ref.line ?? ''}` : `  (${n.kind})`}
                </Text>
              )}
            </Button>
          )
        })}
      </Box>
      {picked !== undefined && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="suggestion" paddingX={1}>
          <Text weight="bold" wrap="truncate-end">{picked.node.label}</Text>
          {picked.node.ref !== undefined && (
            <Text dimColor wrap="truncate-start">
              {IN_REPO.includes(picked.node.kind) ? `${picked.node.ref.path}:${picked.node.ref.line ?? ''}` : `${picked.node.kind}, called at ${picked.node.ref.path}:${picked.node.ref.line ?? ''}`}
            </Text>
          )}
          {picked.via !== undefined && (
            <Text dimColor wrap="wrap">
              reached from {label.get(picked.via.from)} · {picked.via.confidence}: {picked.via.label}
            </Text>
          )}
          {note !== null && <Markdown text={note} />}
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {picked.node.ref !== undefined && (
              <Button key="flow:open" label="open code" onPress={() => app.openRef(picked.node.ref!)} />
            )}
            {picked.via !== undefined && (
              <Button key="flow:link" label="how is it reached?" onPress={fire(k, () => app.explainEdge(flow.edges.indexOf(picked.via!)))} />
            )}
          </Box>
        </Box>
      )}
      {flow.notes.length > 0 && <Markdown text={flow.notes.map(n => `- ${n}`).join('\n')} dimColor />}
      {traceInput}
    </Box>
  )
}

// ---------------------------------------------------------------------------

type Exchange = { q: InloopTurn; a?: InloopTurn }

/** The conversation as question-and-answer pairs, oldest first. */
function exchangesOf(convo: readonly InloopTurn[]): Exchange[] {
  const out: Exchange[] = []
  for (const t of convo) {
    if (t.role === 'you') out.push({ q: t })
    else if (out.length > 0 && out[out.length - 1]!.a === undefined) out[out.length - 1]!.a = t
  }
  return out
}

function answerView(k: Kit, ex: Exchange, key: string): RenderElement {
  const app = k.app
  const { Box, Text, Button, Markdown } = k.el
  if (ex.a === undefined) {
    return <Text color="suggestion">{spin(k.s.frame)} {k.s.status.busy ?? 'waiting'}…</Text>
  }
  const steps = ex.a.steps ?? []
  return (
    <Box flexDirection="column">
      <Markdown text={ex.a.text} />
      {steps.map((st, i) => stepView(k, st, `${key}:step:${i}`, 8))}
      {steps.length === 0 && (ex.a.refs ?? []).slice(0, 4).map((r, j) => (
        <Button key={`${key}:ref:${j}`} plain onPress={() => app.openRef(r)}>↗ {refLabel(r)}</Button>
      ))}
    </Box>
  )
}

/**
 * The newest question and its answer first, with the follow-ups right under
 * the question (always in reach); earlier questions folded below.
 */
async function askTab(k: Kit): Promise<RenderElement> {
  const app = k.app
  const { Box, Text, Button, Markdown } = k.el
  const ctx = k.s.ctx
  const exchanges = exchangesOf(k.s.convo)
  if (exchanges.length === 0) {
    return (
      <Markdown
        text={[
          'Ask in plain words. inloop finds the code itself and answers briefly, with the code beside it.',
          '',
          '- *What happens when I click Login?*',
          '- *Only explain how tokens are created.*',
          '- *How did login work three months ago?*',
          '',
          'Nothing here reaches the coding agent.',
        ].join('\n')}
      />
    )
  }
  const latest = exchanges[exchanges.length - 1]!
  const earlier = exchanges.slice(0, -1).reverse().slice(0, 15)
  const answered = latest.a
  const isFlowNew = k.s.flow !== null && k.s.flow.at >= latest.q.at
  return (
    <Box flexDirection="column">
      {ctx.revLabel !== undefined && <Text color="warning" wrap="wrap">studying {ctx.revLabel}</Text>}
      <Text weight="bold" color="suggestion" wrap="wrap">{latest.q.label ?? latest.q.text}</Text>
      {answered !== undefined && (
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Button key="ask:simpler" label="simpler" onPress={fire(k, () => app.followUp('simpler'))} />
          <Button key="ask:deeper" label="more detail" onPress={fire(k, () => app.followUp('detail'))} />
          <Button key="ask:listen" label="▶ listen" onPress={fire(k, () => app.listenTo(latest.q, answered))} />
          {isFlowNew && <Button key="ask:flow" label="see the flow" onPress={() => app.setTab('flow')} />}
        </Box>
      )}
      {answerView(k, latest, 'ask:latest')}
      {earlier.length > 0 && <Text dimColor>earlier</Text>}
      {earlier.map(ex => {
        const isOpen = k.s.askOpen === ex.q.at
        return (
          <Box key={`ask:ex:${ex.q.at}`} flexDirection="column">
            <Button key={`ask:open:${ex.q.at}`} plain onPress={() => app.host.state.askOpen.update(cur => (cur === ex.q.at ? null : ex.q.at))}>
              {isOpen ? '▾ ' : '▸ '}{ex.q.label ?? ex.q.text}
            </Button>
            {isOpen && <Box paddingLeft={2} flexDirection="column">{answerView(k, ex, `ask:ex:${ex.q.at}`)}</Box>}
          </Box>
        )
      })}
      <Button key="ask:clear" label="clear conversation" plain onPress={() => app.host.state.convo.update(() => [])} />
    </Box>
  )
}

async function historyTab(k: Kit): Promise<RenderElement> {
  const app = k.app
  const { Box, Text, Button } = k.el
  const history = k.s.history
  const expanded = k.s.expanded
  const marked = history.filter(c => c.bookmarked === true)
  const rest = history.filter(c => c.bookmarked !== true)
  return (
    <Box flexDirection="column">
      <Text dimColor>{history.length} saved explanations (kept on this machine, outside your project)</Text>
      {marked.length > 0 && <Text weight="bold">Bookmarks</Text>}
      {marked.map(c => cardView(k, c, c.id === expanded, 'history'))}
      {rest.length > 0 && <Text weight="bold">Earlier</Text>}
      {rest.slice(0, 40).map(c => cardView(k, c, c.id === expanded, 'history'))}
      <Box flexDirection="row" columnGap={1} marginTop={1}>
        <Button key="hist:clear" label="clear (keep bookmarks)" onPress={() => app.clearHistory(true)} />
        <Button key="hist:clearall" label="clear all" onPress={() => app.clearHistory(false)} />
      </Box>
    </Box>
  )
}

async function gitTab(k: Kit): Promise<RenderElement> {
  const app = k.app
  const table = k.el
  const { Box, Text, Button } = table
  const Input = hasFields(k) && 'Input' in table ? table.Input : undefined
  const git = k.s.git
  const ctx = k.s.ctx
  if (!app.repo.isGit) return <Text>This project is not a git repository.</Text>
  const selected = git.commits.find(c => c.sha === git.selected)
  return (
    <Box flexDirection="column">
      {Input !== undefined && (
        <Input key="gitq" placeholder="Search commits (words or a sha)…" value={git.query} submitLabel="search" onSubmit={(v: string) => app.gitSearch(v)} />
      )}
      {Input !== undefined && (
        <Input
          key="gitat"
          placeholder="Study code as of… (3 months ago, a sha)"
          submitLabel="study"
          onSubmit={(v: string) => app.detach(async () => {
            const msg = await app.studyRevision(v).catch(err => String((err as Error).message ?? err))
            app.host.toast(msg)
          })}
        />
      )}
      {git.error !== undefined && <Text color="error">{git.error}</Text>}
      {git.compareFrom !== undefined && (
        <Text color="suggestion">compare from {git.compareFrom.slice(0, 7)}: pick a second commit, then "compare"</Text>
      )}
      <Box flexDirection="column" marginTop={1}>
        {git.commits.slice(0, 25).map(c => (
          <Button key={`commit:${c.sha}`} plain onPress={() => app.gitSelect(c.sha)}>
            {c.sha === git.selected ? '● ' : '  '}
            {c.short} <Text dimColor>{c.date}</Text> {c.subject}
          </Button>
        ))}
      </Box>
      {selected !== undefined && (
        <Box flexDirection="column" marginTop={1}>
          <Text weight="bold" wrap="truncate-end">{selected.short} · {selected.subject}</Text>
          <Text dimColor>{selected.author} · {selected.date} · press a file for its diff</Text>
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Button key="git:explain" label="explain commit" variant="primary" onPress={fire(k, () => app.setTab('feed').then(() => app.explainCommit(selected.sha)))} />
            <Button key="git:study" label="study code at this commit" onPress={fire(k, async () => app.host.toast(await app.studyRevision(selected.sha)))} />
            {git.compareFrom === undefined || git.compareFrom === selected.sha
              ? <Button key="git:from" label="compare from here" onPress={() => app.host.state.git.update(g => ({ ...g, compareFrom: selected.sha }))} />
              : (
                <Button
                  key="git:compare"
                  label={`compare ${git.compareFrom.slice(0, 7)} → ${selected.short}`}
                  onPress={fire(k, async () => {
                    const from = git.compareFrom!
                    await app.host.state.git.update(g => ({ ...g, compareFrom: undefined }))
                    await app.setTab('feed')
                    const ctxNow = await app.host.state.ctx.get()
                    await app.compare(from, selected.sha, ctxNow.scope ?? '')
                  })}
                />
              )}
          </Box>
          {git.files.slice(0, 40).map((f, i) => (
            <Button key={`gitfile:diff:${i}`} plain onPress={() => app.openCommitFile(selected.sha, f.path, true)}>
              <Text color={f.status === 'A' ? 'success' : f.status === 'D' ? 'error' : 'warning'}>{f.status} </Text>
              {f.path}
            </Button>
          ))}
        </Box>
      )}
    </Box>
  )
}

async function settingsTab(k: Kit): Promise<RenderElement> {
  const app = k.app
  const table = k.el
  const { Box, Text, Button, Markdown } = table
  const Select = hasFields(k) && 'Select' in table ? table.Select : undefined
  const Input = hasFields(k) && 'Input' in table ? table.Input : undefined
  const s = k.s.settings
  const usage = k.s.usage
  const voiceOptions = [
    ...(app.canUseKokoro ? KOKORO_VOICES.map(v => ({ value: `kokoro:${v.id}`, label: `${v.label} — Kokoro` })) : []),
    ...rankVoices(app.voices).slice(0, 8).map(v => ({ value: v.name, label: `${v.name} — Mac` })),
  ]
  if (Select === undefined || Input === undefined) {
    return <Markdown text={`mode **${s.mode}**, depth **${s.depth}**. Change them with \`/inloop-mode\` and \`/inloop-depth\`.`} />
  }
  return (
    <Box flexDirection="column" rowGap={1}>
      <Select
        key="set:mode"
        label="mode  "
        value={s.mode}
        options={[
          { value: 'auto', label: 'auto — explain meaningful edits as they happen' },
          { value: 'focus', label: 'focus — only edits about one topic' },
          { value: 'ask', label: 'ask — explain only when asked' },
          { value: 'paused', label: 'paused — no automatic explanations' },
        ]}
        onSelect={(v: string) => app.setSettings({ mode: v as typeof s.mode })}
      />
      <Input key="set:focus" label="focus topic " value={s.focus} placeholder="e.g. database queries" onSubmit={(v: string) => app.setSettings({ focus: v.trim(), mode: v.trim() === '' ? s.mode : 'focus' })} />
      <Select
        key="set:depth"
        label="depth "
        value={s.depth}
        options={[
          { value: 'beginner', label: 'beginner — plain words, terms defined' },
          { value: 'intermediate', label: 'intermediate — practical, real names and lines' },
          { value: 'advanced', label: 'advanced — full technical detail' },
        ]}
        onSelect={(v: string) => app.setSettings({ depth: v as typeof s.depth })}
      />
      <Select
        key="set:engine"
        label="automatic explanations "
        value={s.autoEngine}
        options={[
          { value: 'model', label: 'written by a model (small extra usage)' },
          { value: 'static', label: 'static analysis only (no model calls)' },
        ]}
        onSelect={(v: string) => app.setSettings({ autoEngine: v as typeof s.autoEngine })}
      />
      <Select
        key="set:score"
        label="explain edits from significance "
        value={String(s.minScore)}
        options={['1', '2', '3', '4', '5', '6', '8'].map(v => ({ value: v, label: v === '1' ? '1 (almost everything)' : v === '8' ? '8 (only big steps)' : v }))}
        onSelect={(v: string) => app.setSettings({ minScore: Number(v) })}
      />
      <Select
        key="set:quiet"
        label="group edits until quiet for "
        value={String(s.quietSeconds)}
        options={['3', '6', '10', '20', '40'].map(v => ({ value: v, label: `${v}s` }))}
        onSelect={(v: string) => app.setSettings({ quietSeconds: Number(v) })}
      />
      <Select
        key="set:automodel"
        label="model for automatic cards "
        value={s.autoModel}
        options={[{ value: 'haiku', label: 'haiku' }, { value: 'sonnet', label: 'sonnet' }, { value: 'opus', label: 'opus' }]}
        onSelect={(v: string) => app.setSettings({ autoModel: v })}
      />
      <Select
        key="set:askmodel"
        label="model for questions "
        value={s.askModel}
        options={[{ value: 'haiku', label: 'haiku' }, { value: 'sonnet', label: 'sonnet' }, { value: 'opus', label: 'opus' }]}
        onSelect={(v: string) => app.setSettings({ askModel: v })}
      />
      <Select
        key="set:reader"
        label="questions investigated by "
        value={s.useReader ? 'reader' : 'lookups'}
        options={[
          { value: 'reader', label: "a read-only Claude Code agent (searches and reads like Claude Code)" },
          { value: 'lookups', label: "inloop's own lookups (faster, fewer tokens)" },
        ]}
        onSelect={(v: string) => app.setSettings({ useReader: v === 'reader' })}
      />
      <Select
        key="set:style"
        label="style "
        value={s.style}
        options={[
          { value: 'written', label: 'written — explanations with their code, to read' },
          { value: 'spoken', label: 'spoken — read aloud, the code shown as each part is discussed' },
        ]}
        onSelect={(v: string) => app.setSettings({ style: v as typeof s.style })}
      />
      <Select
        key="set:autovoice"
        label="natural voice "
        value={s.autoVoiceSetup ? 'auto' : 'manual'}
        options={[
          { value: 'auto', label: 'download automatically when missing (~200 MB, once)' },
          { value: 'manual', label: 'only when I install it' },
        ]}
        onSelect={(v: string) => app.setSettings({ autoVoiceSetup: v === 'auto' })}
      />
      <Select
        key="set:brief"
        label="coding agent's replies "
        value={s.briefAgent ? 'brief' : 'normal'}
        options={[
          { value: 'brief', label: 'brief — inloop explains the code (auto mode)' },
          { value: 'normal', label: 'normal' },
        ]}
        onSelect={(v: string) => app.setSettings({ briefAgent: v === 'brief' })}
      />
      <Select
        key="set:voice"
        label="voice "
        value={s.voice === '' || !voiceOptions.some(o => o.value === s.voice) ? '' : s.voice}
        options={[{ value: '', label: `automatic (${describePlan(app.voicePlan(''))})` }, ...voiceOptions]}
        onSelect={(v: string) => app.detach(async () => {
          await app.setSettings({ voice: v })
          await app.speak('This is the voice inloop will use.')
        })}
      />
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Button key="set:testvoice" label="test voice" onPress={fire(k, () => app.speak('Here is how I sound when I explain a change to you.'))} />
        {!app.isKokoroReady && app.host.canPlayClips && k.s.status.isVoiceSettingUp !== true && (
          <Button key="set:kokoro" label="install natural voice (Kokoro)" onPress={fire(k, async () => app.host.toast(await app.setupKokoro()))} />
        )}
        <Button key="set:reloadvoices" label="reload voices" plain onPress={fire(k, () => app.refreshVoices().then(() => app.host.toast(`using ${describePlan(app.voicePlan(s.voice))}`)))} />
      </Box>
      {!app.canUseKokoro && <Markdown dimColor text={app.host.canPlayClips ? VOICE_HELP : NO_PLAYER_HELP} />}
      <Text dimColor>
        inloop model use this session: {usage.calls} calls · {usage.inputTokens.toLocaleString()} in · {usage.outputTokens.toLocaleString()} out tokens
      </Text>
      <Markdown
        dimColor
        text="inloop only reads. Code excerpts go to the session's own Claude model and nowhere else; `.env` files, keys and credentials are never read, and secrets are masked. History stays in Claude Code's local plugin store, outside your project."
      />
    </Box>
  )
}
