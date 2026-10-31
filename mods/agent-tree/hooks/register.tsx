import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, TurnUsage } from 'claude-code'

import type { AgentNode, AgentNodeStatus } from '../types'

const PANE = 'agent-tree'
const TITLE = 'Agents'
const MAIN = 'main'

const blankNode = (id: string): AgentNode => ({
  id,
  type: 'agent',
  description: '',
  model: '',
  status: 'running',
  startedAt: Date.now(),
  toolCount: 0,
  tools: [],
  costUsd: 0,
})

const nodes = atom({ plugin: 'agent-tree', key: 'nodes' } as const, [])
const main = atom({ plugin: 'agent-tree', key: 'main' } as const, {
  ...blankNode(MAIN),
  name: 'Orchestrator',
  status: 'done',
  durationMs: 0,
})
const collapsed = atom({ plugin: 'agent-tree', key: 'collapsed' } as const, [])
// Session spend, kept apart from the cards so clearing finished ones does not lower it.
const spent = atom({ plugin: 'agent-tree', key: 'spent' } as const, 0)
const autoOpened = atom({ plugin: 'agent-tree', key: 'autoOpened' } as const, false)

const BADGE: Record<AgentNodeStatus, { text: string; color: string }> = {
  running: { text: '● Running', color: 'yellow' },
  done: { text: '✓ Done', color: 'green' },
  failed: { text: '✗ Failed', color: 'red' },
  aborted: { text: '■ Stopped', color: 'gray' },
}

// USD per million tokens: input, output, 1-hour cache write, cache read.
// From platform.claude.com/docs/en/about-claude/pricing, read 2026-10-19. Claude Code writes
// its cache with the 1-hour TTL. Haiku uses its up-to-100K-prompt tier, since a turn's usage
// is summed over requests and the per-request prompt length is not known here.
const PRICES: [family: string, rates: [number, number, number, number]][] = [
  ['fable', [10, 50, 20, 0.25]],
  ['opus', [4, 20, 8, 0.2]],
  ['sonnet', [2, 10, 4, 0.1]],
  ['haiku', [0.1, 0.5, 0.2, 0.01]],
]

const costOf = (usage: TurnUsage | undefined) => {
  if (!usage) return 0
  const rates = PRICES.find(([family]) => usage.model.includes(family))?.[1]
  if (!rates) return 0
  const [input, output, cacheWrite, cacheRead] = rates
  return (
    (usage.input_tokens * input +
      usage.output_tokens * output +
      (usage.cache_creation_input_tokens ?? 0) * cacheWrite +
      (usage.cache_read_input_tokens ?? 0) * cacheRead) /
    1_000_000
  )
}

// "claude-sonnet-5-5" reads as "Sonnet 5.5", "claude-opus-4-20250514" as "Opus 4".
const prettyModel = (model: string) =>
  model
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-(\d{1,2})(?:-(\d{1,2}))?$/, (_, major: string, minor?: string) =>
      minor ? ` ${major}.${minor}` : ` ${major}`,
    )
    .replace(/^\w/, first => first.toUpperCase())

const titleOf = (node: AgentNode) => {
  const raw = node.name ?? node.type
  return raw.charAt(0).toUpperCase() + raw.slice(1)
}

// An MCP tool is tagged by its server ("mcp__claude_ai_Notion__search" → "Notion"), others by name.
const toolTag = (tool: string) => {
  const server = /^mcp__(?:claude_ai_)?([^_]+(?:_[^_]+)*?)__/.exec(tool)?.[1]
  return server ?? tool
}

const money = (usd: number) => `$${usd.toFixed(2)}`

const elapsed = (node: AgentNode) => {
  const ms = node.durationMs ?? Date.now() - node.startedAt
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

// A loop's events can arrive before agent.spawn's continuation records the node, so every
// writer creates a placeholder for an unknown id; the spawn fills in the details later.
const upsert = (list: AgentNode[], id: string, patch: (node: AgentNode) => Partial<AgentNode>) => {
  const found = list.find(one => one.id === id)
  const base = found ? fill(found) : blankNode(id)
  const next = { ...base, ...patch(base) }
  return found ? list.map(one => (one.id === id ? next : one)) : [...list, next].slice(-200)
}

// State outlives a reload of the mod, so a node saved by an older version may lack newer fields.
const fill = (node: AgentNode): AgentNode => ({ ...blankNode(node.id), ...node })

// Open: listed, even if waiting undrawn on a narrow terminal or behind another tab.
const isPaneOpen = async ($: EngineInterface) =>
  (await $.ui.panes()).some(pane => pane.id === PANE)

// Visible: actually on screen, the only time the transcript's Agent rows may fold into it.
const isPaneVisible = async ($: EngineInterface) =>
  (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced && pane.isShown)

// A finished card is hidden rather than deleted so a later resume brings it back with its details;
// one with a running descendant stays so the descendant keeps its place in the tree.
const hideFinished = (list: AgentNode[]) => {
  const running = new Set<string>()
  const byId = new Map(list.map(node => [node.id, node]))
  for (const node of list) {
    if (node.status !== 'running') continue
    for (let at: AgentNode | undefined = node; at && !running.has(at.id); at = at.parentId ? byId.get(at.parentId) : undefined) {
      running.add(at.id)
    }
  }
  return list.map(node => (running.has(node.id) ? node : { ...node, isHidden: true }))
}

// A running subagent with no tool call or turn start for this long is flagged; it may only be
// thinking through a long answer, hence the question mark on the badge.
const STALL_MS = 120_000

const isStalled = (node: AgentNode) =>
  node.id !== MAIN &&
  node.status === 'running' &&
  !node.activeTools &&
  Date.now() - (node.lastActivityAt ?? node.startedAt) > STALL_MS

// Fable costs the most per token, so a subagent on it is flagged; the orchestrator may run on it.
const isFableWorker = (node: AgentNode) => node.id !== MAIN && node.model.includes('fable')

// claude-hud draws its own agent line in the status bar; the pane replaces it while on screen.
// The value found before hiding it is kept in $.store, so a crash mid-session still restores it.
const HUD_SAVED = 'hudShowAgents'

const hudConfigPath = async ($: EngineInterface) => {
  const base =
    (await $.env.get('CLAUDE_CONFIG_DIR')) ??
    `${(await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))}/.claude`
  return `${base}/plugins/claude-hud/config.json`
}

type HudConfig = { display?: { showAgents?: boolean } }

// What showAgents held before the pane hid it; 'absent' when the config did not set it.
type HudSaved = boolean | 'absent'

const setHudAgents = async ($: EngineInterface, show: boolean) => {
  const saved = (await $.store.get(HUD_SAVED)) as HudSaved | undefined
  // Nothing to restore, or already hidden by an earlier load.
  if (show === (saved === undefined)) return
  const path = await hudConfigPath($)
  let text: string
  try {
    text = await $.fs.read(path)
  } catch {
    return // claude-hud is not installed here, or has no config of its own: nothing to hide.
  }
  const config = JSON.parse(text) as HudConfig
  const display = (config.display ??= {})
  if (show) {
    // A value the person changed while the pane was up is theirs to keep.
    if (display.showAgents === false) {
      if (saved === 'absent') delete display.showAgents
      else display.showAgents = saved
      await $.fs.write(path, `${JSON.stringify(config, null, 2)}\n`)
    }
    await $.store.delete(HUD_SAVED)
    return
  }
  if (display.showAgents === false) return
  await $.store.set(HUD_SAVED, display.showAgents ?? 'absent')
  display.showAgents = false
  try {
    await $.fs.write(path, `${JSON.stringify(config, null, 2)}\n`)
  } catch (error) {
    await $.store.delete(HUD_SAVED)
    throw error
  }
}

// Module state, reset by each load: whether this load set a status line hint that should go
// once the pane is on screen, whether claude-hud's agent line is (being) hidden, whether hiding
// it failed (so a broken config is not retried on every redraw), and the queue of changes.
let hasStatus = false
let isHudHidden = false
let isHudFailed = false
let hudQueue: Promise<void> = Promise.resolve()

// switches.json turns this mod off in every chat: `"agent-tree": false` in
// ~/.claude/mods/switches.json. Off closes the pane and stops it opening by itself.
const SWITCH = 'agent-tree'
let isOff = false

async function readSwitch($: EngineInterface) {
  let now = false
  try {
    const path = `${$.plugin.root.replace(/\\/g, '/').split('/.claude/')[0] ?? ''}/.claude/mods/switches.json`
    if (await $.fs.exists(path)) now = (JSON.parse(String(await $.fs.read(path))) as Record<string, unknown>)[SWITCH] === false
  } catch {
    now = isOff
  }
  isOff = now
  if (!isOff) return
  // Checked on every tick while off, so a failed close or a racing open is undone too.
  if (hasStatus) {
    hasStatus = false
    $.ui.status(undefined)
  }
  if (await isPaneOpen($)) await $.ui.close({ id: PANE })
}

// Hides and restores run one at a time in the order asked, so a restore never overtakes a hide.
function syncHud($: EngineInterface, show: boolean) {
  isHudHidden = !show
  hudQueue = hudQueue
    .then(() => setHudAgents($, show))
    .catch((error: unknown) => {
      isHudFailed = true
      $.ui.status(`Agents pane could not ${show ? 'restore' : 'hide'} claude-hud's agent line: ${String(error)}`)
    })
}

const withTool = (node: AgentNode, tool: string) => ({
  lastActivityAt: Date.now(),
  toolCount: node.toolCount + 1,
  tools: [...node.tools.filter(one => one !== toolTag(tool)), toolTag(tool)].slice(-4),
})

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agent-tree',
      description: 'Show the agent spawn tree as cards in a pane',
    })
    // A reload starts here too: drop any hint an earlier load left behind.
    $.ui.status(undefined)
    // Put claude-hud's agent line back if a session ended without closing the pane; a pane still
    // open after a reload hides it again on its next draw.
    if (!(await isPaneVisible($))) syncHud($, true)
    await readSwitch($).catch(() => undefined)
    $.clock.every(3000, () => void readSwitch($).catch(() => undefined))
    // Keeps the elapsed time of running cards ticking between state changes.
    $.clock.every(1000, async () => {
      const [list, root] = [await read($, nodes), await read($, main)]
      if (root.status === 'running' || list.some(node => node.status === 'running')) {
        $.ui.invalidate('ui.render')
      }
    })

    return next(e)
  })

  // The command toggles the pane.
  on('command.run', { command: 'agent-tree' }, async $ => {
    if (isOff) return { text: 'The agent tree is off. Set "agent-tree": true in ~/.claude/mods/switches.json to turn it on.' }
    if (await isPaneOpen($)) {
      await $.ui.close({ id: PANE })
      return { text: 'Agent tree pane closed.' }
    }
    await $.ui.open({ id: PANE, title: TITLE })
    $.ui.invalidate('ui.render')

    return { text: 'Agent tree pane opened.' }
  })

  // However the pane closes (the command, its button, ctrl+x x), redraw the Agent rows in full.
  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE) {
      $.ui.invalidate('ui.render')
      syncHud($, true)
    }

    return closed
  })

  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    // Restores only what this mod hid: setHudAgents does nothing without a saved value. A failure
    // reaches the engine's hook-failure log; the session has already ended by then.
    await hudQueue
    await setHudAgents($, true)

    return ended
  })

  // While the pane is on screen it already shows each subagent, so the transcript's Agent rows
  // fold to one line; otherwise the engine draws its own rows.
  on('ui.render', { component: 'ToolUse', props: { tool: 'Agent' } }, async ($, e, next) => {
    if (!(await isPaneVisible($))) return next(e)
    const { Text } = $.ui.resolve(e)
    const input = (e.props.input ?? {}) as { description?: string; subagent_type?: string }
    const state = e.props.isRunning ? 'running' : e.props.isErrored ? 'failed' : 'done'

    return (
      <Text dimColor>
        ⏺ {input.subagent_type ?? 'Agent'}: {input.description ?? ''} · {state} · in Agents pane
      </Text>
    )
  })

  on('ui.render', { component: 'ToolResult', props: { tool: 'Agent' } }, async ($, e, next) => {
    if (!(await isPaneVisible($))) return next(e)
    const { Box } = $.ui.resolve(e)

    return <Box />
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined || started.agentId === undefined) return started

    const id = started.agentId
    // Keeps any start time and tool count already recorded (a resume, or events that won the race).
    await update($, nodes, list =>
      upsert(list, id, () => ({
        parentId: e.parentAgentId,
        name: e.name,
        type: e.subagentType,
        description: e.description,
        model: started.model,
      })),
    )
    // A plain -p run has no surface to open a pane on.
    if (!isOff && !(await read($, autoOpened)) && (await $.session.surfaces()).length > 0) {
      await update($, autoOpened, () => true)
      // Not awaited, so a slow surface never holds up the spawn.
      void $.ui
        .open({ id: PANE, title: TITLE })
        .then(opened => {
          if (opened.isPlaced) $.ui.invalidate('ui.render')
          else {
            hasStatus = true
            $.ui.status('Agents pane ready: /agent-tree to show it')
          }
        })
        .catch((error: unknown) => {
          hasStatus = true
          $.ui.status(`Agents pane could not open: ${String(error)}`)
        })
    }

    return started
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    const ran = next(e)
    if (e.agentId === undefined) {
      const task = e.text.split('\n')[0]?.slice(0, 120) ?? ''
      await update($, main, (root): AgentNode => ({
        ...root,
        status: 'running',
        startedAt: Date.now(),
        durationMs: undefined,
        description: task || root.description,
      }))
    } else {
      const id = e.agentId
      await update($, nodes, list =>
        upsert(list, id, () => ({
          status: 'running',
          startedAt: Date.now(),
          lastActivityAt: Date.now(),
          durationMs: undefined,
          isHidden: false,
        })),
      )
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    // Start the call first so recording it never delays the tool.
    const ran = next(e)
    if (e.agentId === undefined) {
      await update($, main, saved => {
        const root = fill(saved)
        return { ...root, ...withTool(root, e.tool) }
      })
    } else {
      const id = e.agentId
      await update($, nodes, list =>
        upsert(list, id, node => ({ ...withTool(node, e.tool), activeTools: (node.activeTools ?? 0) + 1 })),
      )
      // An agent inside a long tool call is working, not stalled.
      try {
        return await ran
      } finally {
        await update($, nodes, list =>
          upsert(list, id, node => ({
            activeTools: Math.max(0, (node.activeTools ?? 0) - 1),
            lastActivityAt: Date.now(),
          })),
        )
      }
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    // Hand the turn on first so recording it never delays the answer.
    const ran = next(e)
    const status: AgentNodeStatus =
      e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'aborted' : 'failed'
    const cost = costOf(e.usage)
    const finish = (node: AgentNode): Partial<AgentNode> => ({
      status,
      durationMs: e.durationMs,
      costUsd: node.costUsd + cost,
      model: e.usage?.model ?? node.model,
    })
    await update($, spent, total => total + cost)
    if (e.agentId === undefined) {
      await update($, main, saved => {
        const root = fill(saved)
        return { ...root, ...finish(root) }
      })
    } else {
      const id = e.agentId
      await update($, nodes, list => upsert(list, id, finish))
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    // Drawn means on screen, so the "/agent-tree to show it" hint has done its job.
    if (hasStatus) {
      hasStatus = false
      $.ui.status(undefined)
    }
    // claude-hud's agent line goes only while the pane is actually on screen.
    if (await isPaneVisible($)) {
      if (!isHudHidden && !isHudFailed) syncHud($, false)
    } else if (isHudHidden) syncHud($, true)
    const list = (await read($, nodes)).map(fill).filter(node => !node.isHidden)
    const root = fill(await read($, main))
    const folded = await read($, collapsed)
    // The desktop app has the room to spread siblings side by side; the terminal stacks them.
    const isWide = e.surface === 'desktop'

    const known = new Set(list.map(node => node.id))
    const childrenOf = (id: string) =>
      list.filter(node => (node.parentId && known.has(node.parentId) ? node.parentId : MAIN) === id)
    const total = await read($, spent)
    const fableWorkers = list.filter(isFableWorker).length
    const stalledCount = list.filter(isStalled).length
    const warnings = [
      ...(fableWorkers > 0 ? [`${fableWorkers} fable worker${fableWorkers > 1 ? 's' : ''}`] : []),
      ...(stalledCount > 0 ? [`${stalledCount} stalled`] : []),
    ]

    const toggle = (id: string) =>
      update($, collapsed, ids => (ids.includes(id) ? ids.filter(one => one !== id) : [...ids, id]))

    const card = (node: AgentNode, kids: AgentNode[]) => {
      const stalled = isStalled(node)
      const idleFor = Math.floor((Date.now() - (node.lastActivityAt ?? node.startedAt)) / 60_000)
      const badge = stalled
        ? { text: `◌ Stalled? ${idleFor}m idle`, color: 'red' }
        : (BADGE[node.status] ?? BADGE.done)
      const isOpen = !folded.includes(node.id)
      return (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={stalled || isFableWorker(node) ? 'red' : node.status === 'running' ? 'yellow' : undefined}
          borderDimColor={node.status !== 'running' && !isFableWorker(node)}
          paddingX={1}
          width={isWide ? 44 : undefined}
        >
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Text>
              <Text color="#D97757">✳</Text> <Text bold dimColor={node.status === 'aborted'}>{titleOf(node)}</Text>{' '}
              <Text dimColor>{prettyModel(node.model)}</Text>
            </Text>
            <Text color={badge.color}>{badge.text}</Text>
          </Box>
          {isFableWorker(node) && <Text color="red">⚠ Fable as a worker: the priciest model, rarely needed for a subagent</Text>}
          <Text dimColor={node.status === 'aborted'}>{node.description || ' '}</Text>
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Text>
              <Text bold>{money(node.costUsd)}</Text>
              <Text dimColor>
                {' '}· {elapsed(node)}
                {node.tools.length > 0 ? ` · ${node.tools.map(tool => `[${tool}]`).join('')}` : ''}
              </Text>
            </Text>
            <Box flexDirection="row" gap={1}>
              <Button
                key={`open:${node.id}`}
                plain
                onPress={() => $.ui.view(node.id === MAIN ? {} : { agentId: node.id })}
              >
                <Text dimColor>open ›</Text>
              </Button>
              {kids.length > 0 && (
                <Button key={`fold:${node.id}`} plain onPress={() => toggle(node.id)}>
                  {`${kids.length} ${isOpen ? '⌄' : '›'}`}
                </Button>
              )}
            </Box>
          </Box>
        </Box>
      )
    }

    const branch = (node: AgentNode, depth: number): RenderChildren => {
      const kids = childrenOf(node.id)
      const isOpen = !folded.includes(node.id) && depth < 12
      return (
        <Box key={`node:${node.id}`} flexDirection="column" alignItems={isWide ? 'center' : 'flex-start'}>
          {card(node, kids)}
          {isOpen && kids.length > 0 && (
            <Box
              flexDirection={isWide ? 'row' : 'column'}
              gap={isWide ? 2 : 0}
              marginLeft={isWide ? 0 : 1}
              alignItems="flex-start"
            >
              {kids.map((kid, index) =>
                isWide ? (
                  branch(kid, depth + 1)
                ) : (
                  <Box key={`edge:${kid.id}`} flexDirection="row">
                    <Text dimColor>{index === kids.length - 1 ? '└─' : '├─'}</Text>
                    {branch(kid, depth + 1)}
                  </Box>
                ),
              )}
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" gap={2}>
          <Text bold>
            <Text color="blue">✦</Text> Agents
          </Text>
          <Box flexDirection="row" gap={1}>
            <Text>
              {warnings.length > 0 && <Text color="red">⚠ {warnings.join(' · ')} </Text>}
              <Text dimColor>{list.length + 1} agents</Text> <Text bold>{money(total)}</Text>
            </Text>
            <Button key="close" plain role="dismiss" onPress={() => $.ui.close({ id: PANE })}>
              ✕
            </Button>
          </Box>
        </Box>
        {branch(root, 0)}
        {list.some(node => node.status !== 'running') && (
          <Box marginTop={1}>
            <Button
              key="clear"
              onPress={() => update($, nodes, all => hideFinished(all.map(fill)))}
            >
              Clear finished
            </Button>
          </Box>
        )}
      </Box>
    )
  })
}
