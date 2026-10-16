# inloop

**One AI builds your software. inloop keeps you in the loop.**

inloop is a Claude Code plugin that runs beside the coding agent. While the agent edits your project, inloop watches each meaningful step and explains it in a pane next to the transcript. You never have to ask. You can also ask your own questions at any time: what happens when a button is clicked, where a value comes from, how login worked three months ago. inloop finds the code, traces the flow across files, and points at the exact lines.

It only reads. It never edits files, runs your project's code, installs anything, or changes your git state, and its conversation is kept separate from the coding agent's.

```
┌ transcript (the coding agent) ───────────────┐┌ inloop ──────────────────────────────┐
│ ⏺ Update(server/auth/tokens.js)              ││ 1:▸Feed 2:Code 3:Flow 4:Ask …         │
│   + function isTokenExpiringSoon(claims, s)  ││ ▾ Token expiry-soon check · 45s        │
│   …                                          ││   concept: token expiration check     │
│                                              ││   The agent added isTokenExpiring…    │
│                                              ││   ↗ server/auth/tokens.js:18-22       │
└──────────────────────────────────────────────┘└──────────────────────────────────────┘
```

---

## Install

**From this folder** (any terminal session):

```
claude plugin marketplace add /path/to/inloop
claude plugin install inloop@inloop
```

Or, at the prompt: `/plugin marketplace add /path/to/inloop`, then `/plugin install inloop@inloop`. A plugin installed from a local folder is read from that folder, so after editing it, `/reload-plugins` picks up the change.

**Just for one session, without installing:**

```
claude --plugin-dir /path/to/inloop
```

Requirements: Claude Code 2.1.301 or newer (inloop uses the plugin mod API: function hooks, panes and `$.model`), and `git` for history features. Nothing else to install: no Node packages, no server.

## Run it during development

```bash
claude plugin validate .        # manifest + hooks module, as the engine reads them
claude plugin test .            # 60 tests: logic + engine-level (hooks, pane on terminal/desktop/mobile)
claude --plugin-dir .           # a live session with inloop loaded
```

Type-checking: once a session has loaded the plugin from this folder, the engine writes its API types to `.claude-plugin/types/`, and `npx -p typescript@5.6 tsc -p .` checks the project.

Try it on the bundled demo app. It has a frontend, API routes, authentication, data access, async code, and six dated commits showing how login evolved:

```bash
scripts/make-demo-app.sh /tmp/inloop-demo
cd /tmp/inloop-demo && claude --plugin-dir /path/to/inloop
```

## Using it

### The pane

inloop opens a pane docked beside the transcript when the terminal is wide enough (the fullscreen layout, about 144 columns for a pane nobody asked for). `/inloop` opens it at any width. Drag the divider to resize it. inloop asks for 64 columns, but a width you set yourself wins. When Claude Code's own Diff panel is open, inloop is the tab beside it. Click it, or press Tab to reach it and then Enter.

Above the tabs, a small **Since your last prompt** box lists every file changed since you last sent Claude a prompt, with lines added and removed and the line ranges touched. Edits made through the edit tools and through shell commands are both counted, net: a change that was made and then undone doesn't show. Press a file to open its diff (from the text at your prompt to now) in the Code tab. The box starts over with each prompt. Claude Code can't stack a second pane above another (a second pane becomes a tab behind it), so the box sits at the top of the inloop pane instead.

| Tab | What it shows |
| --- | --- |
| **1 Feed** | Explanations of the agent's work, newest first. Each card has: title, concept, a **changes** list (every file with lines added and removed and the line ranges changed; press one for its diff), the explanation with its code parts, bookmark, go deeper, diff, flow, listen |
| **2 Code** | Read-only viewer: syntax-highlighted source with line numbers and the relevant lines marked, the revision shown (working tree or a commit), callers and callees with confidence, the functions in the file, and diffs |
| **3 Flow** | A traced execution flow as a tree. Press a step to see where it is, an explanation of it, **open code**, and **how is it reached?** (the link from the step before). On desktop, also an SVG diagram |
| **4 Ask** | Your conversation with inloop, separate from the coding agent. Includes the active scope and the revision being studied |
| **5 History** | Explanations from all sessions, with bookmarks. Clear it, or clear everything except bookmarks |
| **6 Git** | Search commits, select one, press a changed file for its diff (then **show file** for the whole file at that commit), explain it, compare two commits, or study the code as of a date or sha |
| **7 Settings** | Mode, focus topic, depth, models, how much is explained, grouping delay, speech, and model usage this session |

The ask field at the bottom of every tab takes a question at any time, including while the agent is working.

The seven tabs are independent: each keeps its own state, so switching away and back finds it as you left it. Inside the Code tab, **◀ previous** steps back after you follow a caller, callee or symbol to another place in the code. While you're looking at an older commit, the top of the pane says **studying <sha>**, with **use current code** to return.

### Automatic explanations

Every successful `Edit`, `Write`, `MultiEdit` or `NotebookEdit`, by the main agent or a subagent, is recorded after the tool has run. Changes made any other way are caught too: after each `Bash` command, and at the end of every turn, inloop asks git which files changed since it last saw them, so a script, `sed` or a formatter run by the agent is explained like an edit. Whatever was already uncommitted when the session started is your own work, and is never explained. The hook adds about 15–30 ms per edit and never changes the tool's result. Edits are grouped into one **step** until the agent goes quiet (6 s by default), a step has run for 45 s, or the turn ends. Each step is analysed statically: new and changed functions, routes, dependencies, topics such as auth or database, and the callers of new code. Then it gets a significance score. A step that clears the threshold gets a card. Comment-only and whitespace edits, lockfiles, build output and binary files never get one. A step that was already explained (say an undo followed by a redo) is not explained twice.

Cards are written by a small model (Haiku by default) from the step's diff, the static facts, and the definitions of functions the new code calls. If that model call fails, or you choose **static analysis only**, the card is written from the analysis alone, with no model call.

### Modes and depth

| Mode | Behaviour |
| --- | --- |
| `auto` (default) | Explains meaningful steps as they happen |
| `focus` | Explains only steps about one topic: `/inloop-focus database queries`. Keywords decide first; when they can't, one cheap classification call decides |
| `ask` | Records steps but explains nothing until you ask (`/inloop-recent`, or **explain recent** in the feed) |
| `paused` | No automatic explanations. Questions, flows and history still work |

Depth (`/inloop-depth beginner|intermediate|advanced`) changes the wording and level of detail, never the facts. Settings persist across sessions.

### Asking questions

Answers are short by default: the direct answer first, about 120 words at most, written as connected prose rather than a list of facts, then up to three parts that point at the code (each adding a detail, not repeating the answer). A question about the whole project ("explain this repo", "what is this for") starts from its big picture: the README, the project manifest, the folder layout and recent commits. So the answer leads with what the project is for (inferred and said so, when nothing states it) before how it works.

inloop only explains the project the session runs in. Started from your home folder (or any folder with no git repository and no project files), it says so instead of searching unrelated folders. The newest question and answer sit at the top of the Ask tab, with **simpler**, **more detail** and **▶ listen** right under the question. Earlier questions fold below; press one to reopen it. Answers stay out of the Feed, which holds the agent's changes, but are kept in History.


Type in the pane's ask field, or use `/inloop <question>`. Examples:

- *What happens when I click the Login button?*
- *Only explain how authentication tokens are generated.* This sets a **scope** that holds for follow-ups until you clear it.
- *Where does this variable come from?* (with code open in the Code tab)
- *Explain that again, but more simply.* / *Don't simplify anything.*
- *Show me how login worked three months ago.*

inloop runs a short investigation, up to five rounds. The model asks for read-only lookups (find symbols, search text, read lines, a symbol with its callers and callees, trace a flow, git log/show, switch revision), inloop runs them itself, and the answer cites files and lines. A reference to a file or line that doesn't exist is dropped. Whatever can't be verified from the code is stated as such.

### Flows

`/inloop-flow what happens when a user logs in`, or the Flow tab's field. The diagram comes from inloop's own static index, not from the model. The model only names where the flow starts, so it cannot invent steps. If it names a function that doesn't exist, the flow notes that it was left out. Each link carries its evidence:

- **━ confirmed**: the call is written in the code and resolves to exactly one definition the file can see (same file, or imported)
- **┅ inferred**: resolved by a name or URL match, such as a `fetch('/api/login')` matched to `app.post('/api/login')`, or a method call whose receiver type isn't checked
- **┈ runtime**: depends on what the program does when it runs, such as a request to a URL with no route in the repo

Language support for the index: JavaScript/TypeScript (including JSX and React components, Express-style routes, `fetch`/`axios` calls, `onClick={handler}`/`addEventListener` callbacks), Python (functions, classes, Flask/FastAPI-style route decorators), Go and Ruby (functions and classes).

### Git history

In the Git tab, or with commands:

```
/inloop-commit 930c0a1            # or words from a commit message
/inloop-compare 2b1a072 HEAD authentication
/inloop-at 3 months ago           # study the code as of a date or sha; "/inloop-at working" to return
```

History is read straight from git's object store (`git show <rev>:<path>`, `git cat-file --batch`, `git log`, `git diff-tree`). There is no checkout, no worktree and no stash, so your branch, index and uncommitted work are never touched. For an approximate date, inloop picks the last commit at or before it and says which one it picked. If nothing is that old, it uses the first commit and says so. While a revision is being studied, questions, the code viewer and flows all read that revision. The index for a commit is built from that commit alone, never mixed with your working tree.

### Two styles: written and spoken

Every explanation is a short summary plus a few **parts**, each a sentence or two with the code it's about. The code is captured when the explanation is made, so later edits don't shift it. You choose how they reach you (`/inloop-style written|spoken`, or Settings → *style*):

- **Written** (default): the newest explanation opens by itself in the Feed, with every part's code snippet inline (`↗` opens the full file). An explanation you opened yourself stays open; new ones don't push it closed.
- **Spoken**: each new explanation is read aloud part by part, and a box pinned at the top of the panel shows the code for the part being read, with **⏮ ⏸ ⏭ ■** controls that take effect immediately, even mid-sentence. Up to three explanations wait their turn. If the panel is hidden behind another panel (such as Claude Code's Diff panel) or you closed it, the same narration and code show in the strip above the prompt. inloop never reopens a panel you closed; `/inloop` brings it back. Any explanation can also be played with **▶ listen**.

**The voice is Kokoro** (Kokoro-82M, Apache-2.0), a free neural voice that runs locally and sounds close to a person. Set it up once with `/inloop-voice setup` (or Settings → *install natural voice*). That downloads ~200 MB into `~/.cache/inloop/` and runs through `uv` in an isolated environment, with nothing installed system-wide. After setup it runs offline, and nothing is sent anywhere. Every part of an explanation is rendered ahead in one go, so there is no gap between parts, and each part plays as a clip that stop, pause and skip cut off at once. Without Kokoro (or without `uv`), inloop uses the Mac's best installed voice instead. Kokoro can take several seconds to start, so while a part is still being rendered the narration box shows **⟳ generating audio…**, and so does the status line. Playback starts as soon as the audio is ready.

Each spoken part is one short plain sentence that doesn't read out code names, paths or line numbers, since the code is on screen. Choose a voice in Settings (with **test voice**) or with `/inloop-voice`, which lists the Kokoro and Mac voices; `/inloop-voice heart`, `/inloop-voice george`, or `/inloop-voice auto`. Only one thing speaks at a time: a confirmation never plays over an explanation.

Long work started from the panel (questions, follow-ups, narration, commit explanations) runs on inloop's own timer, so a button press answers at once. That keeps Claude Code's 10-second limit on presses from cutting an answer or the voice short.

### A quieter coding agent

While inloop is active, it asks the coding agent to keep its own replies to at most two short sentences on what it did, plus anything you need to act on (errors, failing or skipped tests, questions, decisions). No code blocks, change lists or explanations of how the code works, since inloop already shows them, unless you explicitly ask for an explanation. It does this in two places: a section of the system prompt, and a one-line note attached (unseen) to each prompt you type, which the model weighs most. "Active" means all of these:
- auto mode is on
- the session is interactive
- the inloop panel is open (even as a tab behind another panel), or the style is spoken

Otherwise, for example with the panel closed, in a terminal too narrow for it, in paused, ask or focus mode, or in a headless `claude -p` run, the agent's replies are untouched. Turn it off with `/inloop-brief off` or in Settings. The instruction applies to the agent's messages to you, not to reports subagents hand back. This uses the `prompt.compose` hook, which Claude Code doesn't run for personally installed plugins where an organization manages Claude Code centrally.

### Commands

Mod commands can't contain `:`, so they're named `/inloop-…`. Every one runs immediately, even mid-turn. When there's no pane (a headless `claude -p` run, or a narrow terminal), the result is printed instead.

| Command | |
| --- | --- |
| `/inloop [question]` | Open the pane, or ask a question |
| `/inloop-explain [topic \| path[:line[-end]] \| …]` | Explain a topic, a file, some lines, or (with nothing) your selection or the code open in the viewer |
| `/inloop-flow <feature>` | Trace a feature's execution flow |
| `/inloop-commit <sha \| words>` | Explain a commit |
| `/inloop-compare <from> <to> [topic]` | Compare two revisions, optionally about one topic |
| `/inloop-recent [minutes]` | Summarise what changed in the last N minutes (10 by default) |
| `/inloop-focus [topic]` | Focus mode on a topic. Empty leaves focus mode |
| `/inloop-mode auto\|ask\|focus\|paused` | Set the mode |
| `/inloop-depth beginner\|intermediate\|advanced` | Set the depth |
| `/inloop-at <sha \| date \| working>` | Choose the revision being studied |
| `/inloop-history [words]` | Saved explanations |
| `/inloop-settings` | Show the settings and open the Settings tab |
| `/inloop-style written\|spoken` | Written explanations with code, or spoken ones that show the code as they go |
| `/inloop-speak on\|off` | Same as spoken / written |
| `/inloop-brief on\|off` | Keep the coding agent's replies short while inloop is active |
| `/inloop-voice [name \| auto]` | List the voices on this machine, or choose one |

Headless use works too, which is handy for scripts:

```
claude -p --plugin-dir /path/to/inloop "/inloop-commit HEAD"
```

## How it is built

```
.claude-plugin/plugin.json       manifest (+ types contract), marketplace.json
hooks/register.tsx               the hooks module: edit observer, commands, pane, the Host of $ calls
src/app.ts                       controller: batching, significance, bounded queue, questions, navigation, git, settings, history
src/analysis.ts                  symbols, routes, calls, imports, topics, change analysis and scoring
src/graph.ts                     code index, callers/callees with confidence, flow tracing, search
src/explain.ts                   prompts, change cards, the read-only investigation loop, commits, comparisons
src/repo.ts                      read-only project and git access, per-revision index cache
src/diff.ts, src/batcher.ts      unified diffs; edit grouping, hashing, LRU caches
src/security.ts                  path validation, sensitive files, secret masking, safe git arguments
src/ui.tsx                       the pane (terminal, desktop with SVG flows, mobile fallback)
types/index.d.ts                 state contract
tests/                           logic.test.ts, engine.test.tsx (+ a virtual project harness)
scripts/make-demo-app.sh         the demo app with dated history
```

It's a single mod: one hooks module, no MCP server, no extra process, no web server. It uses only documented `$` calls, and `claude plugin validate` lists every one of them, along with every state key it reads and writes.

**Not blocking the agent.** The edit hook only records the edit and returns. Analysis runs on timers. Card work runs one at a time, and at most three steps wait. Beyond that, the oldest two are folded into one rather than queued without limit. Model replies are cached by prompt hash, the index for each commit is cached (a commit never changes), and the working-tree index re-reads only the files that were edited. The one exception is headless runs (`-p`, SDK), which end as soon as their turn does. There, the end of a turn waits up to 60 s for an explanation already under way, so it isn't lost.

## Security and privacy

- **Read-only by construction.** The module has no file-write call at all (validate lists its calls), and the only processes it runs are `git` with read-only subcommands and `say -v '?'` (to list voices), passed as an argument list with no shell. The model never gets tools. It can only ask for inloop's own read-only lookups.
- **Never executes repository code** to explain it.
- **Sensitive files are never read:** `.env*`, keys and certificates, `id_rsa*`, `.npmrc`/`.netrc`/`.git-credentials`, `.aws/`/`.ssh/`, `credentials`/`secrets.*`, service-account JSON, `.git/`. They're also excluded from git greps and patches. Edits to them are noticed but never read.
- **Secrets are masked** before any text goes to the model: common key formats, private keys, JWT-like strings, and quoted values assigned to names like `password`, `token` or `apiKey`. References like `process.env.X` are kept.
- **Untrusted content stays data.** Code, comments, commit messages and file names go to the model inside `<repo_data>` tags, with an instruction never to follow instructions found there.
- **Paths are validated:** anything outside the project root, or escaping it with `..`, is refused. Revisions and dates are checked before they reach git, so nothing option-like and no ranges get through.
- **Where data goes:** code excerpts go only to the session's own Claude model, through Claude Code's client and credentials. Explanation history and settings stay in Claude Code's local plugin store (`~/.claude/plugins/store/`), outside your project. Clear them from the History tab.
- **Off switch:** `/inloop-mode paused`, or disable the plugin.

**Cost.** In auto mode a card costs one small-model call per meaningful step, and trivial steps cost nothing. A question costs up to five calls to the questions model (Sonnet by default). Settings shows how many calls inloop has made this session and how many tokens they used. Set *automatic explanations: static analysis only* for zero background model use.

## Testing

`claude plugin test .` runs 60 tests in the engine's own test kit:

- **Logic** (26): path, sensitive-file, revision and secret rules; symbol, route, React and HTTP-call extraction; significance scoring; focus matching; diffs; batching windows; the demo app's login flow, from the button to the database, with every node checked against its source line and every edge's confidence; callers; natural-language search; the first commit's index (sessions, no JWT); JSON recovery; static cards; voice listing, ranking and choice; spoken-text cleanup.
- **Engine** (22): the plugin loaded by the engine over a virtual project, with a scripted model:
  - an agent `Edit` produces a card with nobody asking, the tool result is untouched, and the prompt is framed as untrusted data and never contains the `.env` secret
  - three edits across files become one card
  - comment-only edits cost nothing
  - focus mode filters
  - paused mode with explain-recent
  - secrets files are never read
  - a flow question draws the real login flow, drops an invented step and a bogus reference, keeps the scope, and opens the code
  - the pane on terminal and desktop: tabs, flow input, node press → code viewer
  - history merges with other sessions, and bookmarks survive a clear
  - the mobile fallback
  - a reload doesn't double-process edits
  - a burst of edits stays bounded
  - back: explanation → code → followed call → back → back returns to the expanded explanation; back with no history returns to the Feed; scrolling stops once the file's end is on screen
  - written style: the newest explanation opens by itself with each part's code
  - spoken style: each part is read with its code pinned on screen, using the best voice, without paths
  - spoken controls cut speech off: next skips a part, pause and resume repeat it, stop ends
  - with the panel hidden, the narration and code show above the prompt
  - the coding agent is asked for brief replies only while inloop is active (panel open or spoken style, auto mode, brief on), never in headless runs
  - the narrow dock (30 columns) uses short tab labels and leaves paths out of the flow tree
  - the **Since your last prompt** box counts edit-tool and shell changes net, opens a file's diff, and starts over with each prompt
  - switching style mid-explanation: written silences at once (a confirmation too), spoken picks up with the next change
  - while Kokoro is still rendering, the pane and status line say audio is being generated

Verified by hand with real Claude Code 2.1.301, the real model and real git, on the demo app:

- **Automatic card from a real agent edit.** In a headless run and in an interactive terminal session, the agent's edit became a card in about 6 s, with correct line references. The edit hook settled in 10–30 ms.
- **Multi-file step.** A logout feature (9 tool calls, 3 files) became one coherent card.
- **Focused question.** *"Only explain how authentication tokens are generated"* stayed on `createToken` and said it was leaving verification out.
- **Flow.** *"What happens when a user logs in"* gave the full traced flow plus an explanation. The coding agent's model took no turns (`num_turns: 0`).
- **Commits.** Explaining a commit, comparing two revisions about a topic, and *"three months ago"* (picked `930c0a1`, 2026‑07‑16, and read only that revision). HEAD, branch, uncommitted diff, index and stash were byte-identical before and after.
- **Interactive pane** in a real terminal: the feed card appeared unprompted, cards expand, the flow tree renders, a node click explains the step and highlights lines 5–13 in the viewer, the Git tab lists commits and explains one.
- **Speech:** `/inloop-voice` listed this Mac's voices without the novelty ones, and choosing *Daniel* made `$.audio.speak` run `say -v "Daniel (English (UK))"`. The audio itself wasn't checked by ear.
- **Styles, live:** spoken mode in a real terminal narrated *part 2 of 3* with exactly the lines discussed. With the panel closed, it showed in the strip above the prompt, and **■ stop** killed the running `say` process.
- **Quieter agent:** the same request got a 115-word reply without the brief instruction and about 60 words with it. The reply still flagged the untested code and the two surprising behaviours.
- **Settings persist across sessions**, and the marketplace install works (checked in a throwaway config directory).

## Known limitations

- **Static analysis is pattern-based**, not a compiler or a language server. Dynamic dispatch, decorators other than routes, re-exports, aliasing, and frameworks with unusual routing can be missed. That's why links say *inferred* or *runtime* when they aren't certain. Mods can't reach Claude Code's language servers, so there's no LSP integration yet.
- **The pane's width** is yours to set. A width you dragged or kept wins over inloop's 64-column request.
- **No "open in editor" button.** The plugin API offers no call to open a file in the IDE, so code is shown in inloop's own read-only viewer.
- **Slash commands leave one short line in the transcript.** In interactive sessions, `/inloop-*` commands print a one-line acknowledgement that says it is not a request for the coding agent. Questions typed in the pane's field leave nothing in the transcript.
- **The flow diagram** is a tree in the terminal (the terminal draws no SVG) and an SVG on desktop. There's no zoom: large flows stop at 22–24 steps with a note, and you can trace further from any step.
- **Speech input is not part of inloop.** Speech output is optional and uses the Mac's own voices. How good it sounds depends on which voices are installed (see Speech). Other platforms use their own synthesizer, without a voice picker.
- History is capped at 150 explanations (bookmarks first) to stay within the plugin store's 4 MiB.

## Troubleshooting

- **No pane.** Widen the terminal, or use the fullscreen layout, or run `/inloop` (it opens at any width). Commands work without the pane, and so do toasts and the status line (`inloop: auto · 3 explained`).
- **No cards appear.** Check the mode (`/inloop-settings`). Raise sensitivity in Settings (*explain edits from significance* → 1). Edits to lockfiles, build output, docs-only and comment-only changes are skipped on purpose. In focus mode, only on-topic steps get cards.
- **A card says "model explanation unavailable".** The model call failed, for example because of rate limits or a model your account can't use. The static card is still shown. Change models in Settings, or choose *static analysis only*.
- **"not a git repository".** History features need git. Everything else works without it.
- **Checking what the plugin did.** `claude --debug-file /tmp/d.log --plugin-dir …` logs every `$` call inloop makes (git runs, model calls with timings, store writes). `claude plugin validate .` lists every call the module can make.

## Future improvements

- Use language servers (when the plugin API exposes them) for exact definitions and references across more languages.
- Show richer runtime evidence for flows, such as test files and API schemas.
- Generate per-concept summaries across history (*"everything I've learned about middleware"*).
- An optional browser companion for very large interactive diagrams.
- More editors and agents: the controller only talks to a small `Host` interface (`src/host.ts`), so another host can drive the same logic.
