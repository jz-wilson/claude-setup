export type Refined = { text: string; changes: string[]; pass: number; style: string }

export type Phase =
  | { kind: 'idle' }
  | { kind: 'picking'; source: string; pass: number; back?: Refined }
  | { kind: 'working'; step: string; run: string; back?: Refined }
  | { kind: 'ready'; refined: Refined }

declare module 'claude-code' {
  interface PluginState {
    'prompt-refiner': { phase: Phase; isHidden: boolean; isExpanded: boolean }
  }
}
