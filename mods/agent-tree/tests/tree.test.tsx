import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const

const spawnInput = (description: string, subagentType: string, parentAgentId?: string) => ({
  tool_use_id: `tu-${description}`,
  prompt: description,
  description,
  subagentType,
  provider: { plugin: 'engine', tier: 'core' as const },
  parentModel: 'claude-opus-5-5',
  parentAgentId,
  background: false,
  fork: false,
})

const finish = (agentId: string, model: string, output_tokens: number) => ({
  answer: 'ok',
  durationMs: 3000,
  isAborted: false,
  turnId: `t-${agentId}`,
  agentId,
  reason: 'answer' as const,
  usage: { model, input_tokens: 0, output_tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
})

const mountPane = (engine: Engine, surface: (typeof SURFACES)[number]) =>
  engine.ui.mount({
    plugin: 'agent-tree',
    surface,
    component: 'Pane',
    requestId: 'agent-tree',
    props: {
      title: 'Agents',
      isFocused: false,
      bodyColumns: 100,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 60 },
      view: {},
    },
  })

for (const surface of SURFACES) {
  test(`draws a card per agent under its spawner, with cost (${surface})`, async ($, on) => {
    const ids: Record<string, string> = {
      researcher: 'a-research',
      scraper: 'a-scrape',
      coder: 'a-code',
      tester: 'a-test',
    }
    on('ui.panes', () => ({ value: [] }))
    on('agent.spawn', ($, e) => ({ model: 'claude-sonnet-5-5', agentId: ids[e.description] }))
    on('session.surfaces', () => ({ value: [surface] }))
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    on('turn.complete', ($, e) => ({ text: e.answer }))

    await $.agent.spawn(spawnInput('researcher', 'general-purpose'))
    await $.agent.spawn(spawnInput('scraper', 'Explore', 'a-research'))
    await $.agent.spawn(spawnInput('coder', 'general-purpose'))
    await $.agent.spawn(spawnInput('tester', 'general-purpose', 'a-code'))
    // 100K Sonnet output tokens at $10/MTok is $1.00.
    await $.turn.complete(finish('a-scrape', 'claude-sonnet-5-5', 100_000))

    const ui = await mountPane($, surface)
    const opens = (await ui.findAll({ type: 'Button' }))
      .map(one => one.key)
      .filter(key => key?.startsWith('open:'))
    expect(opens).toEqual(['open:main', 'open:a-research', 'open:a-scrape', 'open:a-code', 'open:a-test'])
    expect(await ui.find({ text: /✓ Done/ })).toBeDefined()
    expect(await ui.find({ text: /\$1\.00/ })).toBeDefined()
    expect(await ui.find({ text: /5 agents/ })).toBeDefined()

    // Folding the coder hides the tester card.
    await ui.press({ key: 'fold:a-code' })
    const folded = (await ui.findAll({ type: 'Button' })).map(one => one.key)
    expect(folded).not.toContain('open:a-test')

    await ui.press({ key: 'clear' })
    const left = (await ui.findAll({ type: 'Button' })).map(one => one.key)
    expect(left).not.toContain('open:a-scrape')
    expect(left).toContain('open:a-code')
  })

  test(`folds Agent transcript rows only while the pane is open (${surface})`, async ($, on) => {
    let pane: { isPlaced: boolean } | undefined = { isPlaced: true }
    on('ui.panes', () => ({
      value: pane
        ? [{ id: 'agent-tree', title: 'Agents', isShown: pane.isPlaced, isFocused: false, isPlaced: pane.isPlaced }]
        : [],
    }))
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine row</Text>
    })

    const row = {
      plugin: 'agent-tree',
      surface,
      component: 'ToolUse' as const,
      requestId: 'tu-1',
      props: {
        tool_use_id: 'tu-1',
        tool: 'Agent',
        input: { description: 'Compare pricing', subagent_type: 'general-purpose' },
        isRunning: true,
        isErrored: false,
        isInterrupted: false,
      },
    }
    const folded = await $.ui.mount(row)
    expect(await folded.find({ text: /general-purpose: Compare pricing · running · in Agents pane/ })).toBeDefined()

    // Open but waiting undrawn (a narrow terminal): the rows must not fold into a pane nobody sees.
    pane = { isPlaced: false }
    const undrawn = await $.ui.mount({ ...row, requestId: 'tu-2' })
    expect(await undrawn.find({ text: /in Agents pane/ })).toBeUndefined()

    pane = undefined
    const full = await $.ui.mount({ ...row, requestId: 'tu-3' })
    expect(await full.find({ text: /in Agents pane/ })).toBeUndefined()
  })

  test(`flags a Fable worker and hides claude-hud's agent line while drawn (${surface})`, async ($, on) => {
    const files: Record<string, string> = {
      '/home/.claude/plugins/claude-hud/config.json': '{"display":{"showAgents":true,"showTools":true}}',
    }
    mock.env(on, { HOME: '/home' })
    mock.store(on)
    // The engine resolves paths for the host OS, so compare them in one spelling.
    const portable = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
    on('fs.read', ($, e) => {
      const text = files[portable(e.path)]
      if (text === undefined) throw new Error(`ENOENT ${e.path}`)
      return { value: text } as never
    })
    on('fs.write', ($, e) => {
      files[portable(e.path)] = e.text
      return { value: undefined } as never
    })
    const statuses: unknown[] = []
    on('ui.status', ($, e) => {
      statuses.push((e as { text?: string }).text)
      return { value: undefined } as never
    })
    let isShown = true
    on('ui.panes', () => ({
      value: [{ id: 'agent-tree', title: 'Agents', isShown, isFocused: false, isPlaced: true }],
    }))
    on('agent.spawn', () => ({ model: 'claude-fable-5-1', agentId: 'a-fable' }))
    on('session.surfaces', () => ({ value: [surface] }))
    on('ui.open', () => ({ value: { isPlaced: true as const } }))

    await $.agent.spawn(spawnInput('deep dive', 'general-purpose'))
    const ui = await mountPane($, surface)
    expect(await ui.find({ text: /Fable as a worker/ })).toBeDefined()
    expect(await ui.find({ text: /1 fable worker/ })).toBeDefined()

    const hud = '/home/.claude/plugins/claude-hud/config.json'
    expect(statuses.filter(Boolean)).toEqual([])
    expect(JSON.parse(files[hud] ?? '{}').display.showAgents).toBe(false)
    expect(JSON.parse(files[hud] ?? '{}').display.showTools).toBe(true)

    // Moving the pane off screen puts the line back, queued behind the hide.
    isShown = false
    await ui.unmount()
    await mountPane($, surface)
    expect(statuses.filter(Boolean)).toEqual([])
    expect(JSON.parse(files[hud] ?? '{}').display.showAgents).toBe(true)
  })

  test(`a run with no surface records the agent without opening the pane (${surface})`, async ($, on) => {
    let opens = 0
    on('ui.panes', () => ({ value: [] }))
    on('session.surfaces', () => ({ value: [] }))
    on('ui.open', () => {
      opens += 1
      return { value: { isPlaced: true as const } }
    })
    on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a-headless' }))

    await $.agent.spawn(spawnInput('headless', 'Explore'))
    expect(opens).toBe(0)
    const ui = await mountPane($, surface)
    expect(await ui.find({ text: /Explore/ })).toBeDefined()
  })

  test(`an agent whose loop events beat its spawn record still ends up done (${surface})`, async ($, on) => {
    const engine = $
    on('ui.panes', () => ({ value: [] }))
    on('agent.spawn', async () => {
      // The child's whole run finishes before the spawn's continuation records it.
      await engine.turn.complete(finish('a-fast', 'claude-haiku-5-5', 10))
      return { model: 'claude-haiku-5-5', agentId: 'a-fast' }
    })
    on('session.surfaces', () => ({ value: [surface] }))
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    on('turn.complete', ($, e) => ({ text: e.answer }))

    await $.agent.spawn(spawnInput('fast', 'Explore'))

    const ui = await mountPane($, surface)
    expect(await ui.find({ text: /Explore/ })).toBeDefined()
    expect(await ui.find({ text: /✓ Done/ })).toBeDefined()
  })
}
