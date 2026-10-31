import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Phase, Refined } from '../types'
import { GAPS_SYSTEM, REFINE_SYSTEM, STYLES, layout, parseGaps, parseRefined, refinePrompt, wrapLines } from './text'
import type { Gap, QA, StyleKey } from './text'

// A Refine button sits in the hint line under the prompt for the whole chat.
// Pressed, it offers rewrite styles as chips in the band above the box, the way a phone keyboard offers Professional or
// Elaborate, for the prompt in the box (or an idea it asks for when the box
// is empty). The rewrite shows in the band with what changed: Use it fills
// the box, Refine offers the chips again on the rewrite, Discard drops it.
// Nothing runs until the button is pressed.

const NAME = 'prompt-refiner'
const CMD = 'refine'
const MODEL = 'sonnet'
// The gap check only reads short text and returns a few questions as JSON: Haiku at high effort is enough.
const GAPS_MODEL = 'haiku'
// Border and padding on each side.
const CHROME_COLUMNS = 4
const STARTERS = ['Fix a bug', 'Build a feature', 'Research something'] as const
const GUIDES = ['More technical', 'Friendlier tone'] as const

const phase = atom({ plugin: 'prompt-refiner', key: 'phase' } as const, { kind: 'idle' } as Phase)
const isHidden = atom({ plugin: 'prompt-refiner', key: 'isHidden' } as const, false)
const isExpanded = atom({ plugin: 'prompt-refiner', key: 'isExpanded' } as const, false)

// switches.json (~/.claude/mods/) turns this mod off in every chat.
let off = false

async function readSwitch($: EngineInterface) {
  let now = false
  try {
    const path = `${$.plugin.root.replace(/\\/g, '/').split('/.claude/')[0] ?? ''}/.claude/mods/switches.json`
    if (await $.fs.exists(path)) {
      const json = JSON.parse(String(await $.fs.read(path))) as Record<string, unknown>
      now = json[NAME] === false
    }
  } catch {
    now = off
  }
  if (now === off) return
  off = now
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // The next state change redraws anyway.
  }
}

async function log($: EngineInterface, line: string) {
  try {
    const home = $.plugin.root.replace(/\\/g, '/').split('/.claude/')[0] ?? ''
    const path = `${home}/.claude/mods-logs/${NAME}.log`
    let old = ''
    if (await $.fs.exists(path).catch(() => false)) old = String(await $.fs.read(path))
    await $.fs.write(path, `${old}${new Date().toISOString()} ${line}\n`)
  } catch {
    // Logging must never break a refine.
  }
}

const failWhy = (r: { reason: string; error?: string; status?: number | null }) =>
  r.reason === 'api-error' ? `the model call failed (${r.error}${r.status ? ` ${r.status}` : ''})` : r.reason === 'aborted' ? 'the model call timed out' : 'the model gave no text'

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

function setPhase($: EngineInterface, next: Phase) {
  return update($, phase, () => next)
}

// Starts a pass when the phase allows it: one pass at a time, so a double
// press or a second /refine does nothing while one runs.
async function claim($: EngineInterface, step: string, from: (p: Phase) => boolean) {
  const run = `${Date.now()}-${Math.random()}`
  let prev: Phase | undefined
  await update($, phase, (p): Phase => {
    prev = p.kind !== 'working' && from(p) ? p : undefined
    return prev ? { kind: 'working', step, run, back: prev.kind === 'picking' ? prev.back : undefined } : p
  })
  return prev ? { run, prev } : undefined
}

// Writes the phase only while this pass still owns it. A Cancel, a discard,
// a reload takes it over, and the late result is dropped.
async function advance($: EngineInterface, run: string, next: Phase) {
  let owned = false
  await update($, phase, p => {
    owned = p.kind === 'working' && p.run === run
    return owned ? next : p
  })
  return owned
}

// Never throws: a failed call or bad JSON means zero questions, logged.
async function findGaps($: EngineInterface, draft: string): Promise<Gap[]> {
  try {
    const r = await $.model.complete({
      model: GAPS_MODEL,
      system: GAPS_SYSTEM,
      prompt: `Here is the rough prompt. Return the JSON.\n\n<draft>\n${draft}\n</draft>`,
      maxTokens: 800,
      effort: 'high',
      timeoutMs: 45_000,
    })
    if (!r.isAnswered) {
      await log($, `gap check failed: ${failWhy(r)}; going on with 0 questions`)
      return []
    }
    try {
      return parseGaps(r.text)
    } catch (err) {
      await log($, `gap check parse failed: ${errText(err)}; going on with 0 questions`)
      return []
    }
  } catch (err) {
    await log($, `gap check threw: ${errText(err)}; going on with 0 questions`)
    return []
  }
}

// A dismissed question is skipped, not fatal; null once the pass lost the phase.
async function askGaps($: EngineInterface, run: string, gaps: Gap[], back?: Refined): Promise<QA[] | null> {
  const out: QA[] = []
  for (const [i, g] of gaps.entries()) {
    if (!(await advance($, run, { kind: 'working', step: `question ${i + 1} of ${gaps.length}`, run, back }))) return null
    let a: string | null = null
    try {
      a = (await $.ui.ask(g.q, { options: g.options, header: `Refine ${i + 1}/${gaps.length}` })).trim() || null
    } catch {
      a = null
    }
    out.push({ q: g.q, a })
  }
  return out
}

async function write($: EngineInterface, prompt: string) {
  const r = await $.model.complete({ model: MODEL, system: REFINE_SYSTEM, prompt, maxTokens: 2000, effort: 'low', timeoutMs: 60_000 })
  if (!r.isAnswered) throw new Error(failWhy(r))
  return parseRefined(r.text)
}

// Shows the chips for text to rewrite. `back` is the rewrite being refined
// again, which Cancel returns to.
async function pick($: EngineInterface, source: string, pass: number, back?: Refined) {
  if ((await read($, phase)).kind === 'working') return
  await update($, isHidden, () => false)
  // Each new rewrite starts collapsed.
  await update($, isExpanded, () => false)
  await setPhase($, { kind: 'picking', source, pass, back })
}

// One idea question at a time; a second press while it is open does nothing.
let isAsking = false

// The Refine button: the box's text, or an idea asked for when it is empty.
async function pickFromBox($: EngineInterface) {
  if (isAsking) return
  let source = (await $.prompt.read()).text.trim()
  if (!source || source.startsWith('/')) {
    isAsking = true
    try {
      source = (await $.ui.ask('What do you want to get done? A rough idea is enough.', { options: STARTERS, header: 'Refine' })).trim()
    } catch (err) {
      // Dismissed, or no one to ask.
      await log($, `idea ask ended: ${errText(err)}`)
      return
    } finally {
      isAsking = false
    }
    if (!source) return
    // A /refine run while the question was open moved the band on; that wins.
    if ((await read($, phase)).kind !== 'idle') return
  }
  await pick($, source, 1)
}

// One rewrite in the chosen style. A dismissed guidance ask or a failure puts
// the chips back, so another style can be tried.
async function rewrite($: EngineInterface, key: StyleKey) {
  const style = STYLES.find(s => s.key === key)
  if (!style) return
  const claimed = await claim($, `writing it ${style.label.toLowerCase()}`, p => p.kind === 'picking')
  if (!claimed || claimed.prev.kind !== 'picking') return
  const { run, prev } = claimed
  const { source, pass } = prev
  try {
    let qa: QA[] = []
    let guidance: string | undefined
    if (key === 'ask') {
      if (!(await advance($, run, { kind: 'working', step: 'reading for gaps', run, back: prev.back }))) return
      const answered = await askGaps($, run, await findGaps($, source), prev.back)
      if (!answered) return
      qa = answered
    } else if (key === 'guide') {
      try {
        guidance = (await $.ui.ask('How should I change it? Pick one or type your own.', { options: GUIDES, header: 'Guidance' })).trim()
      } catch {
        await advance($, run, prev)
        return
      }
    }
    if (!(await advance($, run, { kind: 'working', step: `writing it ${style.label.toLowerCase()}`, run, back: prev.back }))) return
    const { text, changes } = await write($, refinePrompt(source, style.how, qa, guidance))
    if (await advance($, run, { kind: 'ready', refined: { text, changes, pass, style: style.label } })) {
      await log($, `pass ${pass} ${key}: ${qa.length} questions${guidance ? `, guidance ${JSON.stringify(guidance)}` : ''}`)
    }
  } catch (err) {
    if (!(await advance($, run, prev))) return
    $.ui.toast(`Could not rewrite it: ${errText(err)}.`)
    await log($, `pass ${pass} ${key} failed: ${errText(err)}`)
  }
}

async function useIt($: EngineInterface) {
  const now = await read($, phase)
  if (now.kind !== 'ready') return 'Nothing rewritten to use yet.'
  const filled = await $.prompt.fill({ text: now.refined.text, mode: 'replace' }).catch(async (err: unknown) => {
    await log($, `prompt.fill threw: ${errText(err)}`)
    return null
  })
  if (!filled?.isFilled) {
    const why = filled?.refusal ? `the prompt box refused it (${filled.refusal})` : 'the prompt box did not take it'
    $.ui.toast(`Could not use it: ${why}.`)
    return `Could not use it: ${why}.`
  }
  await setPhase($, { kind: 'idle' })
  $.ui.toast('Rewrite is in the box. Edit it, then press Enter.')
  return 'Rewrite is in the box.'
}

// Cancel from the chips goes back to the rewrite they came from, if any.
function cancel($: EngineInterface, now: Phase) {
  return setPhase($, now.kind === 'picking' && now.back ? { kind: 'ready', refined: now.back } : { kind: 'idle' })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: CMD,
      description: 'Rewrite a prompt in a style you pick; show, hide, expand, use or discard drive the band',
      argumentHint: '[prompt | show | hide | expand | use | discard]',
    })
    // A reload mid-rewrite drops its awaits, so a stuck working phase starts over.
    if ((await read($, phase)).kind === 'working') await setPhase($, { kind: 'idle' })
    await readSwitch($).catch(() => undefined)
    $.clock.every(3000, () => {
      void readSwitch($).catch(() => undefined)
    })
    return result
  })

  on('command.run', { command: CMD }, async ($, e) => {
    if (off) return { text: 'Prompt Refiner is off. Set "prompt-refiner": true in ~/.claude/mods/switches.json to turn it on.' }
    const arg = e.args.trim()
    switch (arg) {
      case 'show':
        await update($, isHidden, () => false)
        return { text: 'Prompt Refiner shown.' }
      case 'hide':
        await update($, isHidden, () => true)
        return { text: 'Prompt Refiner hidden; /refine show brings it back.' }
      case 'use':
        return { text: await useIt($) }
      case 'expand':
        await update($, isExpanded, v => !v)
        return { text: (await read($, isExpanded)) ? 'Showing the whole rewrite.' : 'Showing the short view.' }
      case 'discard':
        await setPhase($, { kind: 'idle' })
        return { text: 'Rewrite discarded.' }
      case '':
        return { text: 'Press Refine under the prompt, or /refine <prompt> to pick a style for it.' }
      default:
        await pick($, arg, 1)
        return { text: 'Pick a style above the prompt.' }
    }
  })

  // The idle Refine button sits in the hint line under the prompt box. During a
  // turn the engine's line ("esc to interrupt") keeps its place.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (off || e.props.isWorking || (await read($, isHidden)) || (await read($, phase)).kind !== 'idle') return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box key="refine-hint" flexDirection="row" alignItems="center" gap={1}>
        <Box flexShrink={1}>
          <Text dimColor wrap="truncate-end">
            {e.props.hint}
          </Text>
        </Box>
        <Button key="refine" label="Refine" variant="primary" onPress={() => pickFromBox($)} />
        <Button key="hide" label="Hide" dimColor onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })

  // The chips, the progress and the rewrite open in the band above the box.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (off || e.props.hasSurvey || (await read($, isHidden))) return next(e)
    const now = await read($, phase)
    if (now.kind === 'idle') return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)

    if (now.kind === 'picking') {
      return (
        <Box key="refine-picking" flexDirection="row" flexWrap="wrap" alignItems="center" gap={1} paddingX={1}>
          <Text color="subtle">Rewrite as</Text>
          {STYLES.map(s => (
            <Button key={s.key} label={s.label} onPress={() => rewrite($, s.key)} />
          ))}
          <Button key="cancel" label="Cancel" dimColor onPress={() => cancel($, now)} />
        </Box>
      )
    }

    if (now.kind === 'working') {
      return (
        <Box key="refine-working" flexDirection="row" justifyContent="space-between" alignItems="center" gap={2} paddingX={1}>
          <Box flexShrink={1}>
            <Text color="suggestion" wrap="truncate-end">
              Refining: {now.step}
            </Text>
          </Box>
          <Button key="cancel" label="Cancel" dimColor onPress={() => setPhase($, now.back ? { kind: 'ready', refined: now.back } : { kind: 'idle' })} />
        </Box>
      )
    }

    const refined = now.refined
    const lines = wrapLines(refined.text, Math.max(10, e.props.bodyColumns - CHROME_COLUMNS))
    // Expanded shows every line; a band taller than maxRows scrolls in the engine's window,
    // so the buttons move to the top where they stay in reach.
    const collapsed = layout(e.props.maxRows, lines.length, refined.changes.length)
    // Only a rewrite that is cut has anything to expand.
    const canExpand = collapsed.more > 0
    const expanded = canExpand && (await read($, isExpanded))
    const fit = expanded ? { body: lines.length, more: 0, changes: refined.changes.length } : collapsed
    const actions = (
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        <Button key="use" label="Use it" variant="primary" onPress={() => useIt($)} />
        <Button key="again" label="Refine" onPress={() => pick($, refined.text, refined.pass + 1, refined)} />
        {canExpand ? (
          <Button key="expand" label={expanded ? 'Show less' : `Show all ${lines.length} lines`} onPress={() => update($, isExpanded, v => !v)} />
        ) : null}
        <Button key="discard" label="Discard" dimColor onPress={() => setPhase($, { kind: 'idle' })} />
      </Box>
    )

    return (
      <Box
        key="refine-ready"
        flexDirection="column"
        paddingX={1}
        borderStyle="round"
        borderColor="promptBorder"
        hover={{ borderColor: 'claude' }}
      >
        <Box flexDirection="row" justifyContent="space-between" gap={2}>
          <Box flexShrink={1}>
            <Text color="text" weight="bold" wrap="truncate-end">
              {refined.style}
            </Text>
          </Box>
          <Text color="subtle">pass {refined.pass}</Text>
        </Box>
        {expanded ? actions : null}
        {lines.slice(0, fit.body).map(line => (
          <Text color="text" wrap="truncate-end">
            {line || ' '}
          </Text>
        ))}
        {fit.more > 0 ? (
          <Text color="subtle" wrap="truncate-end">
            +{fit.more} more lines
          </Text>
        ) : null}
        {refined.changes.slice(0, fit.changes).map(change => (
          <Text color="success" wrap="truncate-end">
            + {change}
          </Text>
        ))}
        {expanded ? null : actions}
      </Box>
    )
  })
}
