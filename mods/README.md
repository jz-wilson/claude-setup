# Mods

Mods are Claude Code plugins whose hooks module is TypeScript: they can draw UI (a pane beside the chat, a band above the prompt, a button in the hint line) and react to what the session does. Two I use every day:

| Mod | What it does |
|---|---|
| [agent-tree](agent-tree/) | A live pane with the subagent spawn tree: who spawned whom, on which model, what each one is doing now, and what the session has spent |
| [prompt-refiner](prompt-refiner/) | A **Refine** button under the prompt that rewrites your draft in a style you pick, shows what changed, and lets you use it, refine again or discard it |

## Install

This repo is also a plugin marketplace:

```bash
claude plugin marketplace add jz-wilson/claude-setup
claude plugin install agent-tree@claude-setup
claude plugin install prompt-refiner@claude-setup
```

Or inside Claude Code: `/plugin marketplace add jz-wilson/claude-setup`, then `/plugin install agent-tree@claude-setup`. Restart the session to load them.

## agent-tree

- **Opens by itself** the first time a subagent spawns in a session that has a pane surface, and `/agent-tree` toggles it. It never opens where nothing can draw it (`claude -p`, a headless run).
- **One card per agent,** nested under the agent that spawned it: model ("Sonnet 5.5"), status, elapsed time, the tool it is running (MCP tools are tagged by server), and the token cost of its turns.
- **Stall flag:** a running subagent with no tool call or new turn for two minutes, and no tool still running, gets a `Stalled?` badge and a red border. It may only be thinking through a long answer, hence the question mark. The main session is never flagged.
- **Fable warning:** a subagent running on Fable gets a red border and a warning line, and the header counts them, because it is the priciest model and rarely needed for a worker. The main session may run on it unflagged.
- **Session spend** stays in the header even after you clear finished cards. Prices are a table in `hooks/register.tsx`, read from the public pricing page on 2026-10-19; update `PRICES` when they change.
- **Folds the transcript:** while the pane is on screen, the transcript's Agent rows collapse into it, and they redraw in full when it closes.
- **claude-hud:** if you use the [claude-hud](../claude-hud/README.md) status line, the pane hides its agent line while visible (`showAgents` in claude-hud's config) and restores the original value afterwards, even after a crash.

## prompt-refiner

- **Nothing runs until you press Refine** (in the hint line under the prompt) or type `/refine`.
- **Styles** appear as chips above the prompt: Clearer, Shorter, Elaborate, Structured, Ask me first, My guidance. With an empty box it asks for the idea first.
- **Ask me first** runs a quick gap check on Haiku that returns a few questions, then folds your answers into the rewrite.
- **Rewrites run on Sonnet.** Each press is a real model call, billed like any other request.
- **Use it** fills the prompt box, **Refine** offers the chips again on the rewrite, **Discard** drops it. One pass runs at a time; a second press does nothing until it finishes.
- Failed or cancelled model calls are logged to `~/.claude/mods-logs/prompt-refiner.log`, for debugging.
- Edit the styles, their instructions and the system prompts in `hooks/text.ts`.

## Turning them off

Both read `~/.claude/mods/switches.json`, a file you create by hand: `{ "agent-tree": false }` turns that mod off in every chat without uninstalling it, and `true` or a missing entry turns it on. (The `mods` switchboard in [claude-mods](https://github.com/jz-wilson/claude-mods) writes the same file from a pane.) The path assumes the default `~/.claude` config folder. `claude plugin uninstall <name>@claude-setup` removes a mod.

## Writing and testing your own

A mod is a folder with `.claude-plugin/plugin.json` and a `hooks/hooks.json` that lists its TypeScript modules. Tests import their kit from `claude-code/testing` and run inside the Claude Code runtime, not plain Bun:

```bash
claude plugin validate mods/agent-tree
claude plugin test mods/agent-tree
claude plugin test mods/prompt-refiner
```

The repo's `bunfig.toml` keeps `bun test` out of `mods/` for that reason.
