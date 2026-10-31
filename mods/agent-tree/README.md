# agent-tree

A live pane that draws the subagent spawn tree as cards. User guide: [mods/README.md](../README.md#agent-tree). This file is the rebuild spec: with it, `.claude-plugin/plugin.json`, `hooks/hooks.json` and `types/index.d.ts`, `hooks/register.tsx` can be rewritten so `claude plugin test mods/agent-tree` passes. Tests live in `tests/tree.test.tsx` and run on two surfaces, `terminal` and `desktop`.

## Files

| File | Role |
|---|---|
| `hooks/hooks.json` | `{ "modules": ["./register.tsx"] }` |
| `hooks/register.tsx` | The whole mod. One export: `register: Register = on => { ... }`. Imports `atom, read, update` and types `EngineInterface, Register, RenderChildren, TurnUsage` from `'claude-code'`, and `AgentNode, AgentNodeStatus` from `'../types'` |
| `types/index.d.ts` | `AgentNode`, `AgentNodeStatus`, and the `PluginState['agent-tree']` shape |

## Conventions the engine gives you

- `on(event, filter?, handler)`. A handler is `async ($, e, next)`. `$` is the engine; `next(e)` runs whatever sits below this plugin and returns its result. Returning `next(e)` unchanged is "do nothing".
- Handlers that only record state call `next(e)` first (or start it without awaiting) so recording never delays the session, then write state, then return that result.
- Every state-recording handler (`agent.spawn`, `turn.start`, `tool.call`, `turn.complete`) ends with `.catch(($, e, next) => next(e))`, so a bug in this mod never blocks the session.
- State is `atom({ plugin: 'agent-tree', key } as const, initial)`, read with `read($, atom)`, written with `update($, atom, oldValue => newValue)`. `atom` takes exactly two arguments, the `{ plugin, key } as const` identity and the initial value. The source passes no `shape` option or any third argument; types come from `PluginState` in `types/index.d.ts`.
- Engine calls used: `$.command.register`, `$.ui.status(text | undefined)`, `$.ui.panes()`, `$.ui.open({id, title})`, `$.ui.close({id})`, `$.ui.invalidate('ui.render')`, `$.ui.view({agentId} | {})`, `$.ui.resolve(e)` (returns `Box`, `Text`, `Button`), `$.clock.every(ms, fn)`, `$.env.get(name)`, `$.fs.read/write/exists`, `$.store.get/set/delete`, `$.session.surfaces()`, `$.plugin.root`.

## Mod loader constraints

- Any helper that takes `$` as a parameter must be a top-level function (`isPaneOpen`, `isPaneVisible`, `hudConfigPath`, `setHudAgents`, `syncHud`, `readSwitch`). The loader rejects `$` being passed into a function nested inside `register`. Closures created inside a handler that use that handler's own `$` (the Pane's `toggle`, `card`, `branch`, button `onPress` arrows) are what the source does and are fine. The Pane drawing itself is not a helper: it is the body of the `ui.render` handler for `Pane`, which receives `$` directly, and the Pane's inner functions (`toggle`, `card`, `branch`) close over that `$` rather than taking it as a parameter. `readSwitch` takes `$` and is top-level.
- Module state (`hasStatus`, `isHudHidden`, `isHudFailed`, `hudQueue`, `isOff`) is module-level `let`s, not inside `register`.
- `atom({ plugin: 'agent-tree', key: 'nodes' } as const, ...)` needs the plugin and key as inline string literals, so a constant such as `PANE` or `SWITCH` there would fail. All five atoms are declared at module top level. (Constants are fine for the pane id, the switch name and the store key.)
- Pure helpers (`blankNode`, `costOf`, `prettyModel`, `titleOf`, `toolTag`, `money`, `elapsed`, `upsert`, `fill`, `hideFinished`, `isStalled`, `isFableWorker`, `withTool`) are top-level and take no `$`.

## State

Atoms, all under plugin `agent-tree`:

| Key | Initial | Meaning |
|---|---|---|
| `nodes` | `[]` | Subagent nodes, oldest first, capped to the newest 200 on insert |
| `main` | blank node with id `main`, `name: 'Orchestrator'`, `status: 'done'`, `durationMs: 0` | The main session's card |
| `collapsed` | `[]` | Ids of cards whose children are folded |
| `spent` | `0` | Session spend in USD. Separate from the cards so clearing them never lowers it |
| `autoOpened` | `false` | The pane has been auto-opened once this session |

Blank node (`blankNode(id)`): `{ id, type: 'agent', description: '', model: '', status: 'running', startedAt: Date.now(), toolCount: 0, tools: [], costUsd: 0 }`. Node fields beyond that are in `types/index.d.ts` (`parentId`, `name`, `durationMs`, `isHidden`, `lastActivityAt`, `activeTools`). `fill(node)` = `{ ...blankNode(node.id), ...node }`, applied to anything read from state, because state saved by an older version may lack newer fields.

`upsert(list, id, patch)`: find the node by id; base is `fill(found)` or `blankNode(id)`; result is `{ ...base, ...patch(base) }`. Existing node: replace in place. Unknown id: append, then keep only the last 200. This exists because a child's loop events (`turn.start`, `tool.call`, `turn.complete`) can arrive before `agent.spawn`'s continuation records it, so every writer creates a placeholder for an unknown id and the spawn fills in details later without clobbering status, start time or tool count.

## Event handlers

| Event (filter) | Behaviour | Returns |
|---|---|---|
| `session.start` | Register command `agent-tree`, description `Show the agent spawn tree as cards in a pane`. Call `$.ui.status(undefined)` (drops a hint a previous load left). If the pane is not currently visible, queue a claude-hud restore. Run `readSwitch` once (errors ignored), then `$.clock.every(3000, readSwitch)` and `$.clock.every(1000, ...)` which calls `$.ui.invalidate('ui.render')` only if main or any node is `running` (keeps elapsed times ticking) | `next(e)` |
| `command.run` (`{command: 'agent-tree'}`) | Toggle. Off: return the off text. Pane open (listed in `$.ui.panes()` by id `agent-tree`, shown or not): `$.ui.close({id})`, text `Agent tree pane closed.` Otherwise `$.ui.open({id:'agent-tree', title:'Agents'})`, invalidate `ui.render`, text `Agent tree pane opened.` | `{ text }` |
| `ui.close` | `closed = await next(e)`; if `e.id === 'agent-tree'`, invalidate `ui.render` and queue a claude-hud restore. This covers every way the pane closes | `closed` |
| `session.end` | `ended = await next(e)`; await the hud queue; call `setHudAgents($, true)` directly (restores only what this mod hid; does nothing with no saved value) | `ended` |
| `ui.render` (`{component:'ToolUse', props:{tool:'Agent'}}`) | If the pane is not visible, `next(e)`. Else a single dim `Text`: `⏺ <subagent_type or 'Agent'>: <description or ''> · <state> · in Agents pane`. `state` is `running` if `props.isRunning`, else `failed` if `props.isErrored`, else `done`. Input is `props.input` with `description` and `subagent_type` | element |
| `ui.render` (`{component:'ToolResult', props:{tool:'Agent'}}`) | If the pane is not visible, `next(e)`. Else an empty `<Box />` | element |
| `agent.spawn` | `started = await next(e)`. If `started.deny !== undefined` or no `started.agentId`, return `started`. Else `upsert` node `started.agentId` with `parentId: e.parentAgentId`, `name: e.name`, `type: e.subagentType`, `description: e.description`, `model: started.model` (no status or time fields, so a race-recorded status survives). Then auto-open (below) | `started` |
| `turn.start` | `ran = next(e)` (not awaited yet). If `e.agentId` is undefined, update `main`: `status 'running'`, `startedAt now`, `durationMs undefined`, `description` = first line of `e.text` cut to 120 chars (kept as before if empty). Else upsert the node: `status 'running'`, `startedAt now`, `lastActivityAt now`, `durationMs undefined`, `isHidden false` (a resume un-hides a card) | `await ran` |
| `tool.call` | `ran = next(e)`. Main (`agentId` undefined): update `main` with `withTool`. Subagent: upsert with `withTool` plus `activeTools + 1`, then `try { return await ran } finally { activeTools = max(0, activeTools - 1), lastActivityAt = now }`, so a long tool call is not a stall | `ran` |
| `turn.complete` | `ran = next(e)`. `status` = `done` if `e.reason === 'answer'`, `aborted` if `'aborted'`, else `failed`. `cost = costOf(e.usage)`. Add `cost` to `spent`. Patch the node (main or subagent by `e.agentId`): `status`, `durationMs: e.durationMs`, `costUsd: node.costUsd + cost`, `model: e.usage?.model ?? node.model` | `ran` |
| `ui.render` (`{component:'Pane', requestId:'agent-tree'}`) | Draws the pane. See Pane below | element |

`withTool(node, tool)` returns `{ lastActivityAt: now, toolCount: node.toolCount + 1, tools }` where `tools` = existing list without the same tag, then the new tag appended, keeping the last 4.

### Auto-open (inside `agent.spawn`)

Only if the mod is not off, `autoOpened` is false and `$.session.surfaces()` is non-empty (a headless `-p` run has none, so the pane is never opened and `$.ui.open` is never called). Set `autoOpened` true, then call `$.ui.open({id:'agent-tree', title:'Agents'})` without awaiting it, so a slow surface never holds up the spawn. When it resolves: if `isPlaced`, invalidate `ui.render`; otherwise set the status hint `Agents pane ready: /agent-tree to show it` and remember that a hint is up. On rejection, set status `Agents pane could not open: <error>` and remember the hint is up. The hint is cleared (`$.ui.status(undefined)`) the next time the Pane draws or when the mod is switched off.

### Pane open versus visible

- Open: any entry in `$.ui.panes()` with id `agent-tree`, even one waiting undrawn on a narrow terminal. Used by the toggle and the off switch.
- Visible: an entry with `id === 'agent-tree' && isPlaced && isShown`. Used by the transcript-row folding and the claude-hud hide.

## Pane

Props include `e.surface` (`terminal` or `desktop`). `isWide = surface === 'desktop'`.

First, in this order: clear the hint if one is up; if the pane is visible, hide the hud line (only when not already hidden and no earlier hide failed), else if the hud line is hidden, restore it. Then read `nodes` (each through `fill`, dropping `isHidden` ones), `main` (through `fill`), `collapsed`, `spent`.

Tree shape: a node's parent is `parentId` if that id is among the visible nodes, otherwise `main`. So children of a hidden or unknown parent hang off `main`. `main` is the root of the tree. Walk is depth first, siblings in list order; depth is capped at 12 (a card at depth 12 is drawn but its children are not).

Header row (`Box` row, space-between, gap 2): left `<Text bold><Text color="blue">✦</Text> Agents</Text>`. Right is a row `Box` (gap 1) holding `<Text>` with, in order, an optional `<Text color="red">⚠ <warnings joined by ' · '> </Text>` (trailing space), `<Text dimColor><list.length + 1> agents</Text>`, a space, `<Text bold>$<spent></Text>`; then the close button `<Button key="close" plain role="dismiss" onPress={close pane}>✕</Button>`, whose only child is the string `✕` (no `label` prop). Warnings: `<n> fable worker` (plural `workers` when n > 1) when n > 0, then `<n> stalled` when n > 0. The count of agents includes main, so main plus 4 spawned is `5 agents`.

Card (rounded bordered column, `paddingX` 1, fixed `width` 44 on desktop, auto on terminal):

- Title row (`Box` row, space-between, gap 1): left is one `Text` containing `<Text color="#D97757">✳</Text>`, a space, `<Text bold dimColor={status === 'aborted'}>{title}</Text>`, `{' '}`, `<Text dimColor>{prettyModel(model)}</Text>`. The title has no colour of its own, so the Orchestrator (main) is plain bold default colour like any other card; only the glyph is coloured. Title is `name ?? type` with the first letter upper-cased (`Explore`, `General-purpose`, `Orchestrator`). Right is `<Text color={badge.color}>{badge.text}</Text>`.
- Fable warning line, red, only for a Fable worker: `⚠ Fable as a worker: the priciest model, rarely needed for a subagent`.
- Description line: `<Text dimColor={status === 'aborted'}>{description || ' '}</Text>`; dim only when aborted.
- Footer row (`Box` row, space-between, gap 1): left is one `Text` holding `<Text bold>{money(costUsd)}</Text>` and `<Text dimColor>` with the string ` · <elapsed>` plus, when `tools` is non-empty, ` · ` and each tag as `[tag]` concatenated (`[Read][Notion]`). Right is a row `Box` (gap 1) with: `<Button key="open:<id>" plain onPress={...}><Text dimColor>open ›</Text></Button>` (child is a dim `Text`; press calls `$.ui.view({})` for `main` and `$.ui.view({agentId: id})` otherwise); and, only if the card has visible children, `<Button key="fold:<id>" plain onPress={toggle}>{`<kidCount> ⌄`}</Button>` (child is the plain string `<kidCount> ⌄` when open or `<kidCount> ›` when folded; press toggles the id in `collapsed`). None of the card buttons use a `label` prop. The `clear` button below is the same style but not `plain`: `<Button key="clear" onPress={...}>Clear finished</Button>`.

Badges (status to text and colour; these are raw colour names, not theme keys): `running` `● Running` yellow; `done` `✓ Done` green; `failed` `✗ Failed` red; `aborted` `■ Stopped` gray. A status not in the table falls back to the `done` badge. A stalled node instead shows `◌ Stalled? <n>m idle` in red, with `n = floor((now - (lastActivityAt ?? startedAt)) / 60000)`.

Borders: colour red if stalled or a Fable worker, yellow if running, otherwise default; border dimmed when the node is not running and not a Fable worker.

Children layout. Each `branch(node, depth)` returns `<Box key="node:<id>" flexDirection="column" alignItems={isWide ? 'center' : 'flex-start'}>` containing the card, then (when the id is not in `collapsed`, depth is under 12, and it has children) a children `Box`. Terminal: that children `Box` is `flexDirection="column"`, `marginLeft` 1, `alignItems="flex-start"`, and each child is wrapped in `<Box key="edge:<kidId>" flexDirection="row">` holding a dim `Text` connector (`├─`, or `└─` for the last child) followed by the child's `branch(...)`. Desktop: the children `Box` is `flexDirection="row"`, `gap` 2, `marginLeft` 0, `alignItems="flex-start"` and holds each child's `branch(...)` directly: there is no `edge:` wrapper and no connector on desktop, and each branch is centred under its parent by the `alignItems: center` on its own `node:` box. Cards are 44 wide on desktop so siblings sit side by side.

Footer of the pane: a `Clear finished` Button, key `clear`, only when any visible node is not `running`. Its press hides finished cards (below).

Clear semantics (`hideFinished`): mark every node `isHidden: true` except running nodes and all their ancestors (walk up `parentId`). Cards are hidden, not deleted, so a resume (`turn.start` sets `isHidden false`) restores them. `spent` is untouched.

Fold semantics: pressing `fold:<id>` adds the id to `collapsed`, or removes it if present; a folded card's children disappear from the draw.

### Elapsed, money, model names

- `money(usd)` = `$` + `usd.toFixed(2)`.
- `elapsed(node)`: `ms = durationMs ?? now - startedAt`, `seconds = round(ms/1000)`; under 60 `<s>s`, else `<m>m <ss>s` with seconds zero-padded to 2.
- `prettyModel`: strip leading `claude-`, strip a trailing `-YYYYMMDD`, turn a trailing `-<1-2 digits>(-<1-2 digits>)?` into ` major.minor` or ` major`, capitalise the first letter. `claude-sonnet-5-5` is `Sonnet 5.5`; `claude-opus-4-20250514` is `Opus 4`; `claude-fable-5-1` is `Fable 5.1`. An empty model gives an empty string.
- `toolTag(tool)`: a name matching `^mcp__(?:claude_ai_)?([^_]+(?:_[^_]+)*?)__` is tagged by the first capture (lazy, so `mcp__claude_ai_Notion__search` is `Notion`, `mcp__helpin__list_tasks` is `helpin`, `mcp__claude_ai_Google_Docs__read_doc` is `Google_Docs`); anything else is tagged by its own name.

### Cost

`costOf(usage)`: zero when `usage` is missing or no family matches. The family is the first row of `PRICES` whose name the model string contains (`usage.model.includes(family)`). Cost is `(input_tokens*in + output_tokens*out + (cache_creation_input_tokens ?? 0)*cacheWrite + (cache_read_input_tokens ?? 0)*cacheRead) / 1_000_000`.

`PRICES`, USD per million tokens as `[input, output, 1-hour cache write, cache read]`, in this order (read from the public pricing page on 2026-10-19; Haiku uses its up-to-100K-prompt tier):

| Family | Input | Output | Cache write | Cache read |
|---|---|---|---|---|
| fable | 10 | 50 | 20 | 0.25 |
| opus | 4 | 20 | 8 | 0.2 |
| sonnet | 2 | 10 | 4 | 0.1 |
| haiku | 0.1 | 0.5 | 0.2 | 0.01 |

So 100,000 Sonnet output tokens cost $1.00.

### Stall and Fable rules

- Stalled: `id !== 'main'`, `status === 'running'`, `activeTools` falsy (0 or undefined), and `now - (lastActivityAt ?? startedAt) > 120_000` ms. Main is never flagged.
- Fable worker: `id !== 'main'` and `model` contains `fable`. Red border, warning line, and the header count. Main may run on Fable unflagged.

## claude-hud integration

claude-hud draws its own agent line in the status bar. While the pane is visible, this mod sets `display.showAgents` to `false` in claude-hud's config, and puts the original back afterwards.

- Config path: built as a plain template string with forward slashes, `${base}/plugins/claude-hud/config.json`, with `base` = `$.env.get('CLAUDE_CONFIG_DIR')` if set (it replaces `~/.claude` entirely), else `${USERPROFILE ?? HOME}/.claude` (`USERPROFILE` is tried first; an unset value must be tolerated). No `path.join`, `resolve` or separator conversion is done, and an env value containing backslashes is used as is. The engine's `fs.read` and `fs.write` resolve the string for the host OS (on Windows a test sees something like `C:\home\.claude\plugins\claude-hud\config.json`), and the test compares after converting backslashes to `/` and dropping a drive letter, so a forward-slash string works on both. Under a test with `HOME=/home` the string is `/home/.claude/plugins/claude-hud/config.json`. (`readSwitch` is different: it does replace backslashes in `$.plugin.root` with `/` before splitting.)
- The value found before hiding is kept in `$.store` under key `hudShowAgents`, as `true`, `false`, or the string `'absent'` (config did not set it). Storing it means a crash mid-session still restores it later.
- `setHudAgents($, show)`:
  1. `saved = $.store.get('hudShowAgents')`. If `show === (saved === undefined)`, return (nothing to restore, or already hidden).
  2. Read the file. A read failure returns silently (no claude-hud or no config: nothing to hide).
  3. Parse JSON; ensure `config.display` exists.
  4. Restore (`show` true): only if `display.showAgents === false`, put back `saved` (delete the key if `'absent'`) and write the file; a value the person changed while the pane was up is theirs to keep. Then `$.store.delete`.
  5. Hide (`show` false): if `showAgents` is already `false`, return. Else store `display.showAgents ?? 'absent'`, set it to `false`, write. If the write throws, delete the stored value and rethrow.
  - Writes are `JSON.stringify(config, null, 2)` plus a trailing newline. Other keys (`showTools`, etc.) are preserved.
- `syncHud($, show)` records `isHudHidden = !show` and chains the change onto a module-level promise queue, so hides and restores run one at a time in the order asked and a restore never overtakes a hide. A rejection sets `isHudFailed = true` (so a broken config is not retried every redraw) and calls `$.ui.status("Agents pane could not <restore|hide> claude-hud's agent line: <error>")`.
- Module state (reset by each load of the file): `hasStatus`, `isHudHidden`, `isHudFailed`, `hudQueue`, `isOff`.
- Triggers: Pane draw when visible hides it (once); Pane draw when not visible while hidden restores; `ui.close` of the pane restores; `session.end` awaits the queue then restores directly; `session.start`, when the pane is not visible, calls `syncHud($, true)` (sets `isHudHidden = false` and queues a restore). When nothing is saved in `$.store` that restore is a no-op: `setHudAgents` sees `saved === undefined` with `show` true, returns before reading any file, and writes nothing. A restore only touches the config when a previous load hid the line and left a saved value. When the pane is already visible at `session.start` (a reload), nothing is queued; the next Pane draw hides the line again because the reload reset `isHudHidden` to false.
- The hide is queued by the render, not awaited by it. Do not add delays to the render path; the tests read the config file immediately after mounting.

## Off switch

`~/.claude/mods/switches.json` containing `"agent-tree": false` turns the mod off. The file is found as: take `$.plugin.root`, replace backslashes with `/`, split on `/.claude/`, take the first part, append `/.claude/mods/switches.json`. `readSwitch`: if the file exists, `off = (parsed['agent-tree'] === false)`; missing file means on; any read or parse error keeps the previous value. While off, on every check (every 3 s tick): clear a hint if one is up (`$.ui.status(undefined)`), and close the pane if it is open (so a failed close or racing open is undone). While off the command returns `The agent tree is off. Set "agent-tree": true in ~/.claude/mods/switches.json to turn it on.` and auto-open does not run.

## Test-to-spec map

All tests run for both `terminal` and `desktop`. Helper in tests: `mountPane` mounts `Pane` with `requestId 'agent-tree'`; `finish` builds a `turn.complete` event with `reason: 'answer'`, `durationMs 3000`, usage with `output_tokens` and zero other tokens.

| Test | Assertions | Spec lines that give it |
|---|---|---|
| card per agent under its spawner, with cost | Button keys starting `open:` in order `open:main, open:a-research, open:a-scrape, open:a-code, open:a-test`; a `✓ Done` text; `$1.00`; `5 agents`; pressing `fold:a-code` drops `open:a-test`; pressing `clear` drops `open:a-scrape` but keeps `open:a-code` | Tree shape and depth-first order (main first, then research, its child scraper, then coder and its child tester; the tester's parent a-code and the scraper's parent a-research are visible nodes); `✓ Done` is main's initial badge and also the scraper's after `turn.complete`; cost: 100,000 Sonnet output tokens is `$1.00` on the scraper card and in the header total; `list.length + 1`; fold toggling; hideFinished (scraper is done with no running descendants, coder is running) and the `clear` button shown because the scraper is not running |
| folds Agent transcript rows only while the pane is open | Visible pane: text matches `general-purpose: Compare pricing · running · in Agents pane`. Pane listed but `isPlaced: false` (hence not visible): no `in Agents pane`. No pane: no `in Agents pane` | ToolUse render and visible-versus-open rule |
| flags a Fable worker and hides claude-hud's agent line | Pane shows `Fable as a worker` and `1 fable worker`; no non-empty status text was set; config `display.showAgents` is `false` and `showTools` still `true`; after the pane is no longer shown and re-mounted, `showAgents` is `true` again | Fable rule, header warning text, hud hide/restore with the store key, path under `HOME`, no status text in the happy path (only `undefined` status calls) |
| a run with no surface records the agent without opening the pane | `$.ui.open` never called; the mounted pane shows text `Explore` | Auto-open condition on `session.surfaces()`; title is the capitalised type |
| an agent whose loop events beat its spawn record still ends up done | Pane has `Explore` and `✓ Done` | `upsert` placeholder rule: spawn patch has no status field, so the `done` set by the early `turn.complete` survives |

Note: none of the tests fire `session.start`, so the command, clock ticks and off switch are specified from the user guide only. The engine mocks in the tests answer `ui.panes`, `agent.spawn`, `session.surfaces`, `ui.open`, `turn.complete`, and (hud test) `env.get`, the store, `fs.read`/`fs.write` and `ui.status`.
