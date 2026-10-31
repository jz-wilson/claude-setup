# prompt-refiner

A Refine button under the prompt that rewrites the draft in a style you pick. User guide: [mods/README.md](../README.md#prompt-refiner). This file is the rebuild spec: with it, `.claude-plugin/plugin.json`, `hooks/hooks.json` and `types/index.d.ts`, `hooks/text.ts` and `hooks/register.tsx` can be rewritten so `claude plugin test mods/prompt-refiner` passes. The test file is `hooks/register.test.tsx`; it imports `REFINE_SYSTEM, STYLES, layout, parseGaps, parseRefined, wrapLines` from `./text`.

## Files

| File | Role |
|---|---|
| `hooks/hooks.json` | `{ "modules": ["./register.tsx"] }` |
| `hooks/text.ts` | Pure text work, no `$`: prompts, parsers, styles, wrapping, layout |
| `hooks/register.tsx` | Engine wiring and UI. One export `register: Register = on => { ... }`. Imports `atom, read, update` and types `EngineInterface, Register` from `'claude-code'`, `Phase, Refined` from `'../types'`, and the helpers above from `./text` |
| `types/index.d.ts` | `Refined`, `Phase`, `PluginState['prompt-refiner']` |

## Types (from `types/index.d.ts`)

- `Refined = { text, changes: string[], pass: number, style: string }` where `style` is the style's label.
- `Phase` is one of `{kind:'idle'}`, `{kind:'picking', source, pass, back?: Refined}`, `{kind:'working', step, run, back?: Refined}`, `{kind:'ready', refined}`. `source` is the text to rewrite; `back` is the earlier rewrite being refined again; `run` is an id owned by one pass.
- Atoms (plugin `prompt-refiner`): `phase` (initial `{kind:'idle'}`), `isHidden` (false), `isExpanded` (false). Read with `read($, atom)`, write with `update($, atom, old => new)`.

## text.ts: exports and exact behaviour

Constants: `MAX_QUESTIONS = 3` (exported), `MAX_BODY_ROWS = 8`, `MAX_CHANGES = 3`, `CHROME_ROWS = 5` (border 2, header 1, button row with room to wrap once 2), skipped-answer text `skipped, no answer`.

Types exported: `Gap = {q, options: string[]}`, `QA = {q, a: string | null}`, `StyleKey` (union of the style keys).

`stripFences(raw)` (internal), in this order: trim; remove a leading fence matching `^```[a-z]*\n?` (case-insensitive, optional language tag, optional newline); remove a closing fence matching `\n?```$`, which only counts at the very end of the trimmed text (a fence mid-text is left alone); trim again.

`parseGaps(raw): Gap[]`:
- Strip fences, then take the substring from the first `{` to the last `}`. No `{`, or no `}` after it: throw.
- `JSON.parse` it; `questions` must be an array or throw (the caller turns any throw into zero questions).
- Walk items, stop at 3 kept. Skip an item whose `q` is not a non-blank string or whose `options` is not an array. Options: keep trimmed non-empty strings, drop `other` (case-insensitive, whole label), drop duplicates, keep at most 3. Skip the question if fewer than 2 options remain. Question text is trimmed and gets a `?` appended when it does not end with one.
- Fenced input like a ` ```json ` block around `{"questions":[{"q":"Which test file is flaky?","options":["auth.test.ts","All of them"]}]}` yields `[{q:'Which test file is flaky?', options:['auth.test.ts','All of them']}]`. Prose with no JSON (`Sure, looks clear.`) throws.

`parseRefined(raw): {text, changes}`:
- Strip fences; `text` is the trimmed content of the first `<prompt>...</prompt>` (case-insensitive tags, lazy match, surrounding whitespace removed). No block or empty body: throw (`the reply had no <prompt> block`).
- `changes`: content of `<changes>...</changes>` (empty if absent), split on newlines, each line stripped of a leading `-`, `*` or bullet `•` with spaces, trimmed, blanks dropped. No cap here.
- The test reply gives changes `['Named the test file from your answer','Added a done check']`; `Here you go: fix it` throws.

`STYLES` (readonly array, this order): each has `key`, `label`, `how`. A `how` must be more than 20 chars.

| key | label | how (essential content; keep these phrases) |
|---|---|---|
| `clearer` | Clearer | Open with the task in one plain sentence, then make the rest clearer and more specific. Keep it close to the draft's length, **at most a third longer**. **Add no steps**, checks or requirements the draft does not ask for. Plain prose and short bullets. |
| `shorter` | Shorter | Cut it to the fewest words that keep every fact and instruction. It must come out shorter than the draft. |
| `elaborate` | Elaborate | Make it fuller: turn vague parts into concrete asks, spell out the steps and details the draft implies, and where something important is unsaid add a line asking the assistant to check or ask me. Keep the draft's own shape and flow. **No headings** and no goal, constraints or done-criteria sections (that is a different style). It must not contain the phrase `add sections`. |
| `structured` | Structured | Start with the line THE JOB and write it as four parts under these exact headings, each on its own line: **THE JOB, THE WHY, THE GUARDRAILS, DONE MEANS**. Nothing before THE JOB. Where it says nothing for a part, write "unknown: ask me". |
| `ask` | Ask me first | Open with the task in one plain sentence, then make it clearer and more specific using my answers. |
| `guide` | My guidance | Rewrite it the way my guidance says; the guidance decides length and shape. |

The label list must contain `Structured` and must not contain `Brief`. `ask` runs the gap check first; `guide` asks for the person's own direction.

`refinePrompt(draft, how, qa = [], guidance?)` builds the user message, joined exactly:
1. `Here is my prompt. Rewrite it.\n\n<draft>\n<draft>\n</draft>\n\nStyle for this rewrite: <how>`
2. If `qa` is non-empty, append `\n\nI answered these questions first. Use the answers; leave out what was skipped.\n\n<answers>\n<lines>\n</answers>`, where lines are `Q: <q>\nA: <a>` (with `skipped, no answer` for a null answer) joined by a blank line.
3. If `guidance`, append `\n\nMy guidance: <guidance>`.

The tests need: the draft present verbatim; the style's `how` present (the clearer test looks for `make the rest clearer`); `A: auth.test.ts` present after answering; `My guidance: mention the CI runner` present.

`GAPS_SYSTEM` (system prompt for the gap check). Wording of the original, to reuse as is:

```
You read a person's rough prompt for an AI coding and research assistant before it is refined.
Find only real gaps: two instructions that contradict each other, or a must-know fact that is missing and would change the work (for example which file or system, the goal behind it, the scope, or how to tell it is done).

Return JSON only, no prose, no code fences, in exactly this shape:
{"questions":[{"q":"<short question ending in a question mark>","options":["<option>","<option>"]}]}

Rules:
- 0 to 3 questions. When the prompt is clear, return {"questions":[]}. Fewer is better.
- Never ask about something the prompt already answers, and never ask about style or nice-to-haves.
- For a conflict, name both sides in the question and offer each side as an option.
- Each question has 2 or 3 short options (1 to 5 words), taken from the prompt where possible. No "Other" option; the person can type their own.
```

No test pins this wording; the parser rules above are the safety net for the format.

`parseGaps` error messages (thrown `Error`s): `no JSON object in the reply` (no `{`, or no `}` after the first `{`) and `no questions list in the reply` (`questions` not an array); invalid JSON throws the parser's own error. `parseRefined` throws `the reply had no <prompt> block`.

`REFINE_SYSTEM` (system prompt for the rewrite). Must say: rewrite a person's prompt for an AI coding and research assistant in the style they picked; return exactly `<prompt>` newline the refined prompt newline `</prompt>` newline `<changes>` newline `- one short line per meaningful change` newline `</changes>` and nothing else; **the style for this rewrite comes with the prompt, follow it exactly, and it overrides every rule below where they differ** (the test looks for the literal `overrides every rule below`); keep every fact, name, path, number, link and tool from the draft and the answers; never invent facts, where something important is unknown say so as a question for the assistant to ask; write in the person's voice (I, we, my); 2 to 5 changes, each under 12 words. It must **not** contain the text `Open with the task` (style-specific wording lives only in `STYLES`, so it cannot fight the chosen style).

`wrapLines(text, width): string[]`: split on `\n`; each paragraph is wrapped on its own. Words are the paragraph split on any whitespace run with empties dropped, so inner runs of spaces or tabs collapse to one space and words are always rejoined with a single space. A paragraph with no words (empty or only whitespace) yields one `''`. Indent is the paragraph's leading whitespace (`^\s*`, copied verbatim, tabs included), prefixed to every output line of that paragraph. Greedy fill: a word starts a new line when the current line is non-empty and `indent.length + line.length + 1 + word.length > width`; a first word on a line never wraps, so an over-long word stays whole on its own line (the Text's truncation cuts it). Trailing `''` lines are dropped at the end. Example: `wrapLines('one two three four', 9)` is `['one two','three','four']`.

`layout(maxRows, lines, changes) -> {body, more, changes}`:
- `room = max(2, maxRows - 5)`.
- `body = max(1, min(8, lines, room))`. If `body < lines && body + 1 > room`, `body = room - 1` (leave a row for the "more lines" note).
- `more = lines - body`.
- `changes = max(0, min(3, changes, room - body - (more > 0 ? 1 : 0)))`.
- Pinned: `layout(14, 3, 2)` is `{body:3, more:0, changes:2}`; `layout(14, 20, 3)` is `{body:8, more:12, changes:0}`; `layout(6, 20, 3)` is `{body:1, more:19, changes:0}`.

## register.tsx: engine surface

Constants: plugin and switch name `prompt-refiner`; command `refine`; rewrite model `sonnet`; gap-check model `haiku`; chrome columns 4 (border plus padding per side); idea starters `Fix a bug`, `Build a feature`, `Research something`; guidance starters `More technical`, `Friendlier tone`.

Engine calls used: `$.command.register`, `$.clock.every(ms, fn)`, `$.fs.exists/read/write`, `$.plugin.root`, `$.ui.invalidate('ui.render')`, `$.ui.resolve(e)` (`Box, Text, Button`), `$.ui.ask(question, {options, header})` (resolves to the answer string; rejects when dismissed), `$.ui.toast(text)`, `$.prompt.read()` (returns `{text, cursor}`), `$.prompt.fill({text, mode:'replace'})` (returns `{isFilled, refusal?}`), `$.model.complete({model, system, prompt, maxTokens, effort, timeoutMs})` (returns `{isAnswered:true, text}` or `{isAnswered:false, reason, error?, status?}`).

Module state, reset by each load: `off` (switch), `isAsking` (an idea question is open).

Mod loader constraints (apply to all of `register.tsx`):

- Any helper that takes `$` as a parameter must be a top-level function (`readSwitch`, `log`, `claim`, `advance`, `findGaps`, `askGaps`, `write`, `pick`, `pickFromBox`, `rewrite`, `useIt`, `cancel`, `setPhase`). The loader rejects `$` being passed into a function nested inside `register`. Handlers inside `register` call these top-level helpers with the `$` the handler received; button `onPress` arrows inside render handlers do the same.
- Module state is a module-level `let` (`off`, `isAsking`), not a field on anything and not inside `register`.
- `atom({ plugin: 'prompt-refiner', key: 'phase' } as const, ...)`: `plugin` and `key` must be string literals written inline. Using the `NAME` constant there fails. (`NAME` is fine everywhere else, e.g. the switch lookup and log path.)
- Atoms are declared at module top level, outside `register`.

### Events

| Event (filter) | Behaviour | Returns |
|---|---|---|
| `session.start` | `result = await next(e)`, then register command `refine`, description `Rewrite a prompt in a style you pick; show, hide, expand, use or discard drive the band`, `argumentHint` `[prompt \| show \| hide \| expand \| use \| discard]`. If the phase is `working` (a reload dropped its awaits), set it `idle`. Run `readSwitch` once (errors ignored), then `$.clock.every(3000, readSwitch)` | `result` |
| `command.run` (`{command:'refine'}`) | If off, return the off text. Else switch on the trimmed args (below) | `{ text }` |
| `ui.render` (`{component:'PromptHint'}`) | The Refine button row, or `next(e)` | element |
| `ui.render` (`{component:'AbovePrompt'}`) | The band, or `next(e)` | element |

`/refine` args:

| Args | Effect | Text returned |
|---|---|---|
| (empty) | none | `Press Refine under the prompt, or /refine <prompt> to pick a style for it.` |
| `show` | `isHidden = false` | `Prompt Refiner shown.` |
| `hide` | `isHidden = true` | `Prompt Refiner hidden; /refine show brings it back.` |
| `use` | `useIt` | its message |
| `expand` | toggle `isExpanded` | `Showing the whole rewrite.` when now true, else `Showing the short view.` |
| `discard` | phase to `idle` | `Rewrite discarded.` |
| anything else | `pick(arg, 1)`: the args are the source text | `Pick a style above the prompt.` |

Off text: `Prompt Refiner is off. Set "prompt-refiner": true in ~/.claude/mods/switches.json to turn it on.`

### Off switch

Path: take `$.plugin.root`, backslashes to `/`, split on `/.claude/`, first part, plus `/.claude/mods/switches.json`. `readSwitch`: if the file exists, `now = (parsed['prompt-refiner'] === false)`; missing means on; a read or parse error keeps the current value. If `now` changed, store it and call `$.ui.invalidate('ui.render')` (ignore a throw). When off, both renders return `next(e)`.

### Logging

`log($, line)` appends `<ISO timestamp> <line>\n` to `<home>/.claude/mods-logs/prompt-refiner.log` (home found as above). It reads the old content when the file exists (`fs.exists`, treating a rejection as false), then writes old plus the new line. Every failure is swallowed, since logging must never break a refine. Lines logged, exact texts (`<err>` is `errText`; `<why>` is `failWhy`):

| When | Line |
|---|---|
| Gap check not answered | `gap check failed: <why>; going on with 0 questions` |
| `parseGaps` threw | `gap check parse failed: <err>; going on with 0 questions` |
| Gap check call threw | `gap check threw: <err>; going on with 0 questions` |
| Idea question dismissed or unanswerable | `idea ask ended: <err>` |
| Rewrite succeeded (still owning the phase) | `pass <pass> <key>: <n> questions`, plus `, guidance <JSON.stringify(guidance)>` when guidance was given |
| Rewrite failed (still owning the phase) | `pass <pass> <key> failed: <err>` |
| `prompt.fill` threw | `prompt.fill threw: <err>` |

`<key>` is the style key (`clearer`, `ask`, ...), `<n>` is the number of QA entries. Each line is preceded by the ISO timestamp and a space, as above.

Helpers: `failWhy(r)` takes `{reason: string; error?: string; status?: number | null}` and checks only these: `reason === 'api-error'` gives `the model call failed (<error>)`, or `the model call failed (<error> <status>)` when `status` is truthy (a 529 `overloaded` reads `the model call failed (overloaded 529)`); `reason === 'aborted'` gives `the model call timed out`; any other reason gives `the model gave no text`. The only reason value the tests exercise is `api-error`; `aborted` is what the source expects for a timeout, but nothing in the tests or types confirms the engine emits it, so keep the catch-all branch. `errText(err)`: message of an Error, else `String(err)`.

### Phase handling and the one-pass guard

- `claim($, step, from)`: make a run id (timestamp plus random). Atomically (inside one `update`): if the current phase is not `working` and `from(phase)` holds, switch to `{kind:'working', step, run, back}` with `back` = the previous phase's `back` when it was `picking`; else leave unchanged. Return `{run, prev}` or undefined. This is why two near-simultaneous presses on a chip start only one rewrite (the second finds `working`).
- `advance($, run, next)`: atomically, only if the phase is `working` with this same `run`, replace it with `next`; return whether it did. A Cancel, discard or reload takes the phase over, so a late result is dropped and never written. Every step of a pass goes through `advance`, and a pass that loses ownership stops quietly.
- `pick($, source, pass, back?)`: do nothing if the phase is `working`. Else `isHidden = false`, `isExpanded = false` (each new rewrite starts collapsed), phase `{kind:'picking', source, pass, back}`.
- `pickFromBox`: return if `isAsking`. `source = (await $.prompt.read()).text.trim()`. If it is empty or starts with `/`, set `isAsking`, ask `What do you want to get done? A rough idea is enough.` with options the starters and header `Refine`; a rejection (dismissed) logs `idea ask ended` and returns with nothing changed; always clear `isAsking`; an empty answer returns. After the answer, if the phase is no longer `idle` (a `/refine` run while the question was open) return. Then `pick(source, 1)`.
- `rewrite($, key)`: find the style (unknown key returns). `claim` with step `writing it <label lower-cased>` allowed only from `picking`. Take `source`, `pass`, `back` from the claimed `picking`. Then:
  - `ask`: advance to step `reading for gaps`, run `findGaps(source)`, then `askGaps`; if that returns null (lost the phase) stop; the answers are `qa`.
  - `guide`: ask `How should I change it? Pick one or type your own.` with the guidance starters as options and header `Guidance`; on dismissal `advance(run, prev)` (the chips come back, with their `back`) and stop; else `guidance` is the trimmed answer.
  - Advance to step `writing it <label lower-cased>`, call `write(refinePrompt(source, style.how, qa, guidance))`, and `advance(run, {kind:'ready', refined:{text, changes, pass, style: style.label}})`; on success log the pass line.
  - On any throw: `advance(run, prev)` (chips back so another style can be tried); if the pass still owned the phase, `$.ui.toast("Could not rewrite it: <error>.")` and log the failure.
- `write`: `$.model.complete({model:'sonnet', system: REFINE_SYSTEM, prompt, maxTokens: 2000, effort: 'low', timeoutMs: 60000})`; not answered throws `failWhy(r)`; otherwise `parseRefined(r.text)`.
- `findGaps` (never throws): `$.model.complete({model:'haiku', system: GAPS_SYSTEM, prompt: "Here is the rough prompt. Return the JSON.\n\n<draft>\n<draft>\n</draft>", maxTokens: 800, effort: 'high', timeoutMs: 45000})`. Not answered, parse failure or a throw: log and return `[]`. Success: `parseGaps(text)`.
- `askGaps`: for each gap `i` of `n`: `advance` to step `question <i+1> of <n>` (carry `back`; null return if ownership lost), then `$.ui.ask(q, {options, header: 'Refine <i+1>/<n>'})`; trimmed answer or `null` if blank or dismissed. Returns the `QA[]`.
- `useIt`: not `ready` returns `Nothing rewritten to use yet.` Else `$.prompt.fill({text: refined.text, mode:'replace'})`; a throw is logged and treated as not filled. If not `isFilled`: toast and return `Could not use it: <why>.` where why is `the prompt box refused it (<refusal>)` or `the prompt box did not take it`. On success phase `idle`, toast `Rewrite is in the box. Edit it, then press Enter.`, return `Rewrite is in the box.`
- Cancel from the chips (`cancel`): back to `{kind:'ready', refined: back}` if `back` exists, else `idle`. Cancel from `working`: the same, using the working phase's `back`.

### UI

All colours are theme keys, never raw colours (the tests reject any `color`, `borderColor` or `backgroundColor` that is not a theme key). Used: `subtle`, `suggestion`, `text`, `success`, `promptBorder`, and hover `claude`. `dimColor` and `variant` are fine.

Hint line, `PromptHint` (props `hint`, `isWorking`): return `next(e)` (engine's own line) when off, `props.isWorking`, `isHidden` is true, or the phase is not `idle`. Otherwise one row `Box` (key `refine-hint`, `flexDirection` row, `alignItems` center, `gap` 1) with three children: an inner `Box flexShrink={1}` holding `<Text dimColor wrap="truncate-end">{props.hint}</Text>` (the engine's hint is what shrinks and truncates, so the buttons never get squeezed); `Button` key `refine` label `Refine` variant `primary` (press runs `pickFromBox`); `Button` key `hide` label `Hide` with `dimColor` (press sets `isHidden` true). The band stays empty when idle; the button lives only here.

Band, `AbovePrompt` (props `hasSurvey`, `bodyColumns`, `maxRows`): `next(e)` when off, `props.hasSurvey`, `isHidden`, or the phase is `idle`. Otherwise by phase:

| Phase | Draw |
|---|---|
| `picking` | Row Box (key `refine-picking`, wrap, gap 1, `paddingX` 1): `Text` `Rewrite as` colour `subtle`; one `Button` per `STYLES` entry with `key` = style key, `label` = style label, press runs `rewrite`; `Button` key `cancel` label `Cancel` dim |
| `working` | Row Box (key `refine-working`, space-between): `Text` colour `suggestion` truncated, reading `Refining: <step>`; `Button` key `cancel` label `Cancel` dim |
| `ready` | The rewrite card below |

Ready card (Box key `refine-ready`, column, `paddingX` 1, round border colour `promptBorder`, hover border `claude`):
1. Header row (space-between): `Text` bold colour `text` truncated with `refined.style`; `Text` colour `subtle` whose text is exactly `pass <n>`. These are two `Text`s.
2. `lines = wrapLines(refined.text, max(10, bodyColumns - 4))`. `collapsed = layout(maxRows, lines.length, changes.length)`. `canExpand = collapsed.more > 0` (only a cut rewrite has anything to expand). `expanded = canExpand && isExpanded`. `fit` = everything (`body = lines.length`, `more 0`, all changes) when expanded, else `collapsed`.
3. Actions row (wrap, gap 1): `Button` `use` label `Use it` primary (runs `useIt`); `Button` `again` label `Refine` (press `pick(refined.text, refined.pass + 1, refined)`, so the next pass rewrites the rewrite and Cancel returns to it); when `canExpand`, `Button` `expand` labelled `Show all <lines.length> lines` or, when expanded, `Show less` (toggles `isExpanded`); `Button` `discard` label `Discard` dim (phase `idle`).
4. Order: when expanded, the actions row goes directly after the header (so the buttons stay in reach on a tall scrolling band); when not expanded, the actions row goes last. Between header and last row: one `Text` per shown body line (colour `text`, truncated; an empty line drawn as a single space), then if `fit.more > 0` a `Text` colour `subtle` `+<more> more lines`, then one `Text` colour `success` per shown change reading `+ <change>` (a plus, a space, the text).

## Test-to-spec map

Rig: engine mocks stand in for what sits below the plugin (`session.start`, `command.register`, `fs.*` with `exists` false, `ui.toast`, `prompt.read`/`prompt.fill`, `model.complete` with queued replies, `turn.start`, and the `AskUserQuestion` tool call that `$.ui.ask` goes through, where a missing answer is a denial). `both` mounts the band (`AbovePrompt`) and the hint (`PromptHint`) together; widths are 40, 80, 144; surfaces `terminal` and `desktop`.

| Test | Assertion | Spec line |
|---|---|---|
| Refine button stays and chips fit every width | `refine` key present at every width and surface after a turn starts; after pressing it every style key is present; no raw colours; `cancel` returns `refine` | Hint row, picking row, theme-key rule, cancel from picking |
| nothing runs until a style is picked, then Use it fills the box | Refine alone makes no model call; `clearer` makes exactly one call (no gap check), containing the draft and `make the rest clearer`; texts exactly `Clearer`, `pass 1`, `+ Named the test file from your answer`; `use` fills the box with the refined text; `refine` back | `rewrite`, `refinePrompt`, header and change `Text`s, `useIt` then idle |
| Ask me first and My guidance | `ask` shows ask header `Refine 1/1`; second model prompt contains `A: auth.test.ts` (first prompt is the gap check); `again` then `guide`: third prompt contains the first rewrite and `My guidance: mention the CI runner`; texts `pass 2` and `My guidance`; `again` then `cancel` returns to `pass 2`; with no guidance answer (dismissed) the `shorter` chip is back | `findGaps`, `askGaps`, `refinePrompt`, `pick` with `back`, cancel rule, guide dismissal |
| rewrite band fits every width and a short band | `use`, `again`, `discard` present; with `maxRows` 8, number of `Text`s in the band minus one is at most 4 | `layout`: room 3 so body plus more-note plus changes is at most 3; the header adds 2 `Text`s |
| empty box asks for the idea; failed call keeps chips | Ask text equals `What do you want to get done? A rough idea is enough.`; dismissal leaves `refine`; with an answer and a failing model, the model prompt contains the idea, the toast contains `overloaded`, the `shorter` chip is back | `pickFromBox`, `failWhy`, rewrite catch |
| band yields to a survey and to Hide | survey prop gives the engine row; `hide` makes the hint line the engine row; `/refine show` brings `refine` back; survey wins over chips | AbovePrompt/PromptHint pass-through rules, `show` arg |
| Refine sits under the box | idle band is the engine row with no `refine` button; the button and `? for shortcuts` sit in the hint; after pressing, the hint line returns the engine's; with `isWorking` the hint is the engine's | Hint and band rules |
| `/refine <text>` and `/refine use` | `elaborate` chip shows after `/refine <draft>`; after picking it and `/refine use`, the box was filled with the refined text | `command.run` default case, `use` case |
| double press runs one rewrite; Cancel drops the late result | Two parallel `clearer` presses make one model call; cancelling while the call is in flight leaves the `refine` button, no `pass` text | `claim`, `advance` ownership |
| parsers and layout | listed in `text.ts` section | `parseGaps`, `parseRefined`, `wrapLines`, `layout` |
| Cancel during a second pass returns to the first rewrite | after cancelling mid-second-pass, texts `pass 1` and `Clearer` | working cancel returns to `back` |
| every style reaches the model; system prompt lets it win | each `how` is over 20 chars; `REFINE_SYSTEM` contains `overrides every rule below` and not `Open with the task` | `STYLES`, `REFINE_SYSTEM` |
| Structured owns the four sections | label list has `Structured`, not `Brief`; structured `how` has the four headings; elaborate has `No headings`, not `add sections`; clearer has `at most a third longer` and `Add no steps` | `STYLES` table |
| Show all expands a long rewrite | 30 bullet lines at `maxRows` 12: `step 30 of` hidden, `more lines` shown, `expand` present; after `expand` it shows `- step 30 of the plan`, no `more lines`, the change text, and `use` before the first body line; `expand` again hides it; a short rewrite has no `expand`, even after `/refine expand` | `layout` (room 7, body 6, more 24), `canExpand`, expanded order, `pick` resetting `isExpanded` |

Ungrounded in the tests (written from the source): the gap-check system prompt wording, log line wording, `/refine hide` text.
