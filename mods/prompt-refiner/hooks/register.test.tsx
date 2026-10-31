import { expect, mock, test } from 'claude-code/testing'
import type { FoundElement } from 'claude-code/testing'
import type { ThemeKey } from 'claude-code'

import { REFINE_SYSTEM, STYLES, layout, parseGaps, parseRefined, wrapLines } from './text'

const PLUGIN = 'prompt-refiner'
const WIDTHS = [40, 80, 144] as const
// AbovePrompt is raised on the terminal and the desktop.
const SURFACES = ['terminal', 'desktop'] as const

const THEME_KEYS: readonly ThemeKey[] = [
  'text', 'inverseText', 'inactive', 'subtle', 'suggestion', 'remember', 'success', 'error',
  'warning', 'merged', 'claude', 'permission', 'planMode', 'autoAccept', 'promptBorder',
  'bashBorder', 'ide', 'diffAdded', 'diffRemoved', 'diffAddedDimmed', 'diffRemovedDimmed',
  'diffAddedWord', 'diffRemovedWord',
]
const COLOR_PROPS = ['color', 'borderColor', 'backgroundColor']

function rawColors(elements: FoundElement[]): string[] {
  return elements.flatMap(element =>
    COLOR_PROPS.map(prop => [prop, element.props[prop]] as const)
      .filter(([, value]) => value !== undefined && !THEME_KEYS.includes(value as ThemeKey))
      .map(([prop, value]) => `${element.type}.${prop}=${String(value)}`),
  )
}

function band(bodyColumns: number, hasSurvey = false, maxRows = 14) {
  return {
    plugin: PLUGIN,
    component: 'AbovePrompt',
    requestId: 'band',
    props: { hasSurvey, isWorking: false, maxRows, bodyColumns, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  } as const
}

const DRAFT = 'fix the flaky login test thing, it keeps failing in ci sometimes'
const IDEA_Q = 'What do you want to get done? A rough idea is enough.'
const GUIDE_Q = 'How should I change it? Pick one or type your own.'
const QUESTION = 'Which test file is flaky?'
const GAPS = JSON.stringify({ questions: [{ q: QUESTION, options: ['auth.test.ts', 'All of them'] }] })
const REFINED = `<prompt>
Find out why auth.test.ts fails now and then in CI, and fix the cause.
- Do not just add retries.
- Done means the test passes 20 runs in a row.
</prompt>
<changes>
- Named the test file from your answer
- Added a done check
</changes>`
const REFINED_2 = '<prompt>\nFix the flaky auth.test.ts in CI; no retries.\n</prompt>\n<changes>\n- Tightened to one line\n</changes>'

// Typed loosely: the AskUserQuestion matcher's full type is too deep for tsc.
type LooseOn = (event: string, match: object, hook: (_$: unknown, e: { questions: { question: string; header: string }[] }) => Promise<unknown>) => void
type On = Parameters<NonNullable<Parameters<typeof test>[2]>>[1]
type Dollar = Parameters<NonNullable<Parameters<typeof test>[2]>>[0]

type Rig = {
  draft: string
  replies: string[]
  prompts: string[]
  asks: { q: string; header: string }[]
  answers: Record<string, string | null>
  filled: string[]
  toasts: string[]
  modelFails: boolean
  beforeReply?: () => Promise<unknown>
}

// Nothing sits beneath the plugin: these hooks stand for the engine.
function rig(on: On): Rig {
  const r: Rig = { draft: DRAFT, replies: [], prompts: [], asks: [], answers: {}, filled: [], toasts: [], modelFails: false }
  mock.clock(on, { now: 0 })
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('command.register', async () => ({ value: undefined }) as never)
  on('fs.exists', async () => ({ value: false }) as never)
  on('fs.read', async () => ({ value: '' }) as never)
  on('fs.write', async () => ({ value: undefined }) as never)
  on('ui.toast', async (_, e) => {
    r.toasts.push((e as { text: string }).text)
    return { value: undefined } as never
  })
  on('prompt.read', async () => ({ value: { text: r.draft, cursor: r.draft.length } }) as never)
  on('prompt.fill', async (_, e) => {
    r.filled.push((e as { text: string }).text)
    return { isFilled: true } as never
  })
  ;(on as unknown as LooseOn)('tool.call', { tool: 'AskUserQuestion' }, async (_$, e) => {
    const { questions } = e
    const first = questions[0] ?? { question: '', header: '' }
    r.asks.push({ q: first.question, header: first.header })
    const a = r.answers[first.question]
    if (a === null || a === undefined) return { deny: 'dismissed' }
    return { result: { questions, answers: { [first.question]: a } } }
  })
  on('model.complete', async (_, e) => {
    r.prompts.push(e.prompt)
    await r.beforeReply?.()
    if (r.modelFails) return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: {} } } as never
    const text = r.replies.shift() ?? '{"questions":[]}'
    return { value: { isAnswered: true, text, usage: {} } } as never
  })
  on('turn.start', async (_, e) => ({ turnId: e.turnId }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return r
}

const start = ($: Dollar) => $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

function hint(isWorking = false) {
  return { plugin: PLUGIN, component: 'PromptHint', requestId: 'hint', props: { isDraft: true, isWorking, hint: '? for shortcuts' } } as const
}

// The hint line under the box and the band above it, mounted together: a find
// or a press goes to whichever one draws the element.
async function both($: Dollar, site: ReturnType<typeof band>, surface: (typeof SURFACES)[number]) {
  const above = await $.ui.mount({ ...site, surface })
  const below = await $.ui.mount({ ...hint(), surface })
  return {
    above,
    below,
    find: async (q: object) => (await above.find(q)) ?? (await below.find(q)),
    findAll: async (q: object) => [...(await above.findAll(q)), ...(await below.findAll(q))],
    press: async (q: object) => ((await below.find(q)) ? below.press(q as never) : above.press(q as never)),
    unmount: async () => {
      await above.unmount()
      await below.unmount()
    },
  }
}

const textOf = async (ui: { find: (q: object) => Promise<FoundElement | undefined> }, text: RegExp) => (await ui.find({ type: 'Text', text }))?.text

test('the Refine button stays through the chat and the chips fit every width', async ($, on) => {
  rig(on)
  await start($)
  await $.turn.start({ turnId: 't1', text: 'go' })
  for (const surface of SURFACES) {
    for (const width of WIDTHS) {
      const ui = await both($, band(width), surface)
      expect(await ui.find({ key: 'refine' }), `Refine at ${width} on ${surface}`).toBeDefined()
      expect(rawColors(await ui.findAll({}))).toEqual([])
      await ui.press({ key: 'refine' })
      for (const s of STYLES) expect(await ui.find({ key: s.key }), `${s.label} at ${width}`).toBeDefined()
      expect(rawColors(await ui.findAll({}))).toEqual([])
      await ui.press({ key: 'cancel' })
      expect(await ui.find({ key: 'refine' })).toBeDefined()
      await ui.unmount()
    }
  }
})

test('nothing runs until a style is picked, then Use it fills the box', async ($, on) => {
  const r = rig(on)
  await start($)
  for (const surface of SURFACES) {
    r.replies = [REFINED]
    r.prompts.length = 0
    const ui = await both($, band(80), surface)
    await ui.press({ key: 'refine' })
    expect(r.prompts.length, 'Refine alone calls no model').toBe(0)
    await ui.press({ key: 'clearer' })
    expect(r.prompts.length, 'one write, no gap check').toBe(1)
    expect(r.prompts[0] ?? '').toContain(DRAFT)
    expect(r.prompts[0] ?? '').toContain('make the rest clearer')
    expect(await textOf(ui, /^Clearer$/)).toBe('Clearer')
    expect(await textOf(ui, /pass/)).toBe('pass 1')
    expect(await textOf(ui, /Named the test file/)).toBe('+ Named the test file from your answer')
    expect(rawColors(await ui.findAll({}))).toEqual([])
    await ui.press({ key: 'use' })
    expect(r.filled.at(-1) ?? '').toContain('Find out why auth.test.ts fails')
    expect(await ui.find({ key: 'refine' })).toBeDefined()
    await ui.unmount()
  }
})

test('Ask me first asks the gaps; My guidance sends the guidance', async ($, on) => {
  const r = rig(on)
  r.replies = [GAPS, REFINED]
  r.answers = { [QUESTION]: 'auth.test.ts', [GUIDE_Q]: 'mention the CI runner' }
  await start($)
  const ui = await both($, band(80), 'terminal')
  await ui.press({ key: 'refine' })
  await ui.press({ key: 'ask' })
  expect(r.asks.at(-1)?.header).toBe('Refine 1/1')
  expect(r.prompts[1] ?? '').toContain('A: auth.test.ts')

  // Refine on the rewrite offers the chips again, for pass 2.
  r.replies = [REFINED_2]
  await ui.press({ key: 'again' })
  await ui.press({ key: 'guide' })
  expect(r.prompts[2] ?? '', 'pass 2 rewrites the last rewrite').toContain('Find out why auth.test.ts')
  expect(r.prompts[2] ?? '').toContain('My guidance: mention the CI runner')
  expect(await textOf(ui, /pass/)).toBe('pass 2')
  expect(await textOf(ui, /^My guidance$/)).toBe('My guidance')

  // Cancel from the chips goes back to the rewrite; a dismissed guidance ask keeps the chips.
  await ui.press({ key: 'again' })
  await ui.press({ key: 'cancel' })
  expect(await textOf(ui, /pass/)).toBe('pass 2')
  r.answers = {}
  await ui.press({ key: 'again' })
  await ui.press({ key: 'guide' })
  expect(await ui.find({ key: 'shorter' })).toBeDefined()
  await ui.unmount()
})

test('the rewrite band fits every width and a short band', async ($, on) => {
  const r = rig(on)
  await start($)
  for (const surface of SURFACES) {
    for (const width of WIDTHS) {
      r.replies = [REFINED]
      const ui = await both($, band(width, false, 8), surface)
      await ui.press({ key: 'refine' })
      await ui.press({ key: 'structured' })
      for (const key of ['use', 'again', 'discard']) expect(await ui.find({ key }), `${key} at ${width}`).toBeDefined()
      // Two Texts share the header row; border (2) and the button row (2, wrapped) take the rest of maxRows.
      expect((await ui.above.findAll({ type: 'Text' })).length - 1).toBeLessThanOrEqual(8 - 4)
      expect(rawColors(await ui.findAll({}))).toEqual([])
      await ui.press({ key: 'discard' })
      await ui.unmount()
    }
  }
})

test('an empty box asks for the idea; a failed call keeps the chips and says why', async ($, on) => {
  const r = rig(on)
  r.draft = '   '
  await start($)
  const ui = await both($, band(80), 'terminal')
  await ui.press({ key: 'refine' })
  expect(r.asks.at(-1)?.q).toBe(IDEA_Q)
  expect(await ui.find({ key: 'refine' }), 'dismissed: nothing happens').toBeDefined()

  r.answers = { [IDEA_Q]: 'make the login test stop flaking' }
  r.modelFails = true
  await ui.press({ key: 'refine' })
  await ui.press({ key: 'shorter' })
  expect(r.prompts[0] ?? '').toContain('make the login test stop flaking')
  expect(r.toasts.at(-1) ?? '').toContain('overloaded')
  expect(await ui.find({ key: 'shorter' }), 'chips back to try again').toBeDefined()
  await ui.unmount()
})

test('the band yields to a survey and to Hide, and /refine show brings it back', async ($, on) => {
  rig(on)
  await start($)
  const survey = await $.ui.mount({ ...band(80, true), surface: 'terminal' })
  expect(await textOf(survey, /engine/)).toBe('engine')
  await survey.unmount()

  const ui = await both($, band(80), 'terminal')
  await ui.press({ key: 'hide' })
  expect(await textOf(ui.below, /engine/)).toBe('engine')
  await $.command.run({ command: 'refine', args: 'show', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(await ui.below.find({ key: 'refine' })).toBeDefined()
  await ui.unmount()

  // A survey over the chips still wins the band.
  const picking = await both($, band(80), 'terminal')
  await picking.press({ key: 'refine' })
  await picking.above.unmount()
  const surveyed = await $.ui.mount({ ...band(80, true), surface: 'terminal' })
  expect(await textOf(surveyed, /engine/)).toBe('engine')
  await surveyed.unmount()
  await picking.below.unmount()
})

test('Refine sits under the box: the idle band stays empty and a turn keeps the engine hint', async ($, on) => {
  rig(on)
  await start($)
  for (const surface of SURFACES) {
    const ui = await both($, band(80), surface)
    expect(await ui.above.find({ key: 'refine' }), 'no button above the box').toBeUndefined()
    expect(await textOf(ui.above, /engine/)).toBe('engine')
    expect(await ui.below.find({ key: 'refine' }), 'button under the box').toBeDefined()
    expect(await textOf(ui.below, /for shortcuts/)).toBe('? for shortcuts')
    expect(rawColors(await ui.below.findAll({}))).toEqual([])
    await ui.press({ key: 'refine' })
    expect(await ui.below.find({ key: 'refine' }), 'hint line goes back to the engine while the chips show').toBeUndefined()
    await ui.press({ key: 'cancel' })
    await ui.unmount()
    const working = await $.ui.mount({ ...hint(true), surface })
    expect(await textOf(working, /engine/), 'engine line during a turn').toBe('engine')
    await working.unmount()
  }
})

test('/refine <text> offers the chips, and /refine use fills the box', async ($, on) => {
  const r = rig(on)
  r.replies = [REFINED]
  await start($)
  const ui = await both($, band(80), 'terminal')
  const run = (args: string) => $.command.run({ command: 'refine', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  await run(DRAFT)
  expect(await ui.find({ key: 'elaborate' })).toBeDefined()
  await ui.press({ key: 'elaborate' })
  await run('use')
  expect(r.filled.at(-1) ?? '').toContain('auth.test.ts')
  await ui.unmount()
})

test('a double press runs one rewrite, and Cancel drops the late result', async ($, on) => {
  const r = rig(on)
  await start($)
  const ui = await both($, band(80), 'terminal')

  r.replies = [REFINED]
  await ui.press({ key: 'refine' })
  await Promise.all([ui.above.press({ key: 'clearer' }), ui.above.press({ key: 'clearer' })])
  expect(r.prompts.length, 'one write').toBe(1)
  await ui.press({ key: 'discard' })

  r.prompts.length = 0
  r.replies = [REFINED]
  r.beforeReply = async () => {
    await ui.press({ key: 'cancel' })
  }
  await ui.press({ key: 'refine' })
  await ui.press({ key: 'clearer' })
  expect(r.prompts.length).toBe(1)
  expect(await ui.find({ key: 'refine' }), 'back to the button').toBeDefined()
  expect(await textOf(ui, /pass/)).toBeUndefined()
  await ui.unmount()
})

test('parsers and layout', () => {
  expect(parseGaps('```json\n' + GAPS + '\n```')).toEqual([{ q: QUESTION, options: ['auth.test.ts', 'All of them'] }])
  expect(() => parseGaps('Sure, looks clear.')).toThrow()
  expect(parseRefined(REFINED).changes).toEqual(['Named the test file from your answer', 'Added a done check'])
  expect(() => parseRefined('Here you go: fix it')).toThrow()
  expect(wrapLines('one two three four', 9)).toEqual(['one two', 'three', 'four'])
  expect(layout(14, 3, 2)).toEqual({ body: 3, more: 0, changes: 2 })
  expect(layout(14, 20, 3)).toEqual({ body: 8, more: 12, changes: 0 })
  expect(layout(6, 20, 3)).toEqual({ body: 1, more: 19, changes: 0 })
})

test('Cancel during a second pass returns to the first rewrite', async ($, on) => {
  const r = rig(on)
  await start($)
  const ui = await both($, band(80), 'terminal')
  r.replies = [REFINED]
  await ui.press({ key: 'refine' })
  await ui.press({ key: 'clearer' })
  r.replies = [REFINED_2]
  r.beforeReply = async () => {
    await ui.press({ key: 'cancel' })
  }
  await ui.press({ key: 'again' })
  await ui.press({ key: 'shorter' })
  expect(await textOf(ui, /pass/)).toBe('pass 1')
  expect(await textOf(ui, /^Clearer$/)).toBe('Clearer')
  await ui.unmount()
})

test('every style reaches the model, and the system prompt lets it win', () => {
  for (const s of STYLES) expect(s.how.length, s.key).toBeGreaterThan(20)
  expect(REFINE_SYSTEM).toContain('overrides every rule below')
  expect(REFINE_SYSTEM).not.toContain('Open with the task')
})

test('Structured owns the four sections; Elaborate and Clearer keep the draft shape', () => {
  const how = (key: string) => STYLES.find(s => s.key === key)?.how ?? ''
  expect(STYLES.map(s => s.label)).toContain('Structured')
  expect(STYLES.map(s => s.label)).not.toContain('Brief')
  for (const heading of ['THE JOB', 'THE WHY', 'THE GUARDRAILS', 'DONE MEANS']) expect(how('structured')).toContain(heading)
  expect(how('elaborate')).toContain('No headings')
  expect(how('elaborate')).not.toContain('add sections')
  expect(how('clearer')).toContain('at most a third longer')
  expect(how('clearer')).toContain('Add no steps')
})

test('Show all expands a long rewrite, keeps the buttons on top, and Show less folds it', async ($, on) => {
  const r = rig(on)
  await start($)
  const long = Array.from({ length: 30 }, (_, i) => `- step ${i + 1} of the plan`).join('\n')
  r.replies = [`<prompt>\n${long}\n</prompt>\n<changes>\n- Split into steps\n</changes>`]
  const ui = await both($, band(80, false, 12), 'terminal')
  await ui.press({ key: 'refine' })
  await ui.press({ key: 'clearer' })
  expect(await textOf(ui, /step 30 of/), 'cut at first').toBeUndefined()
  expect(await textOf(ui, /more lines/)).toBeDefined()
  expect(await ui.find({ key: 'expand' })).toBeDefined()

  await ui.press({ key: 'expand' })
  expect(await textOf(ui, /step 30 of/)).toBe('- step 30 of the plan')
  expect(await textOf(ui, /more lines/)).toBeUndefined()
  expect(await textOf(ui, /Split into steps/)).toBe('+ Split into steps')
  const order = (await ui.findAll({})).map(el => el.key ?? el.text ?? '')
  expect(order.indexOf('use'), 'buttons before the body').toBeLessThan(order.findIndex(k => /step 1 of/.test(k)))

  await ui.press({ key: 'expand' })
  expect(await textOf(ui, /step 30 of/)).toBeUndefined()

  // A short rewrite has nothing to expand.
  r.replies = [REFINED_2]
  await ui.press({ key: 'again' })
  await ui.press({ key: 'shorter' })
  expect(await ui.find({ key: 'expand' })).toBeUndefined()
  await $.command.run({ command: 'refine', args: 'expand', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(await ui.find({ key: 'expand' }), 'nothing to expand even after /refine expand').toBeUndefined()
  await ui.unmount()
})
