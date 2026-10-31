export type AgentNodeStatus = 'running' | 'done' | 'failed' | 'aborted'

export type AgentNode = {
  id: string
  parentId?: string
  name?: string
  type: string
  description: string
  model: string
  status: AgentNodeStatus
  startedAt: number
  durationMs?: number
  toolCount: number
  tools: string[]
  costUsd: number
  isHidden?: boolean
  lastActivityAt?: number
  activeTools?: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-tree': {
      nodes: AgentNode[]
      main: AgentNode
      collapsed: string[]
      autoOpened: boolean
      spent: number
    }
  }
}
