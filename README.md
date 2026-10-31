# claude-setup

How I set up and run Claude Code, written up so anyone can copy the parts they want. Nothing here is tied to one machine or account: every guide uses placeholder paths, and the templates hold no personal data.

| Guide | What it covers |
|---|---|
| [instructions/](instructions/README.md) | Layering the global instruction files: a shareable `AGENTS.md`, a private file imported only where it exists, and a starter set of working rules |
| [hooks/](hooks/README.md) | Guard hooks that enforce the rules that matter: never print secrets, never commit after a failed step, read files with the Read tool. With tests |
| [review/](review/README.md) | The review and verification loop: an independent reviewer, a verifier per finding, a two-round cap, and a `Stop` hook that enforces it |
| [vault/](vault/README.md) | An agent-memory vault: a plain-Markdown git repo that Claude reads before asking you questions, with a structured log for every task, validators, capture, search, a status dashboard and a pre-commit hook. Includes a ready-to-copy template |
| [mods/](mods/README.md) | Two Claude Code mods, installable from this repo as a marketplace: agent-tree (a live pane of the subagent spawn tree, with models, status and cost) and prompt-refiner (a Refine button that rewrites your prompt in a style you pick) |
| [claude-hud/](claude-hud/README.md) | The claude-hud status line on Windows with Git Bash: install, a width-aware wrapper that always runs the newest build, display settings, an offline variant |

Each guide stands alone. A good order for a fresh setup is instructions, then hooks, then review.

## Rebuilding from the docs

Every guide is written so that an AI agent can rebuild its code from the README alone, without the source:

| Guide | Spec | Checked by |
|---|---|---|
| hooks | [hooks/scripts/README.md](hooks/scripts/README.md) | `bun test hooks` |
| review | "Rebuild spec" in [review/README.md](review/README.md) | `bun test review` |
| vault | [vault/template/scripts/README.md](vault/template/scripts/README.md) | `bun test vault` and the "Daily loop" commands |
| mods | [mods/agent-tree/README.md](mods/agent-tree/README.md), [mods/prompt-refiner/README.md](mods/prompt-refiner/README.md) | `claude plugin test mods/<name>` |
| instructions, claude-hud | The files and settings are given in full in the guide | — |

Each spec lists the exported names and signatures the tests import, file formats, CLI flags, exit codes and the exact messages tests match, and ends with a table mapping every test to the rule that implies it. To rebuild a guide, hand an agent its README(s), have it write the code, then copy this repo's test files in and run them. Each spec has been checked this way: a fresh agent given only the README rebuilt the code, and the original tests passed against it.

Scripts need [Bun](https://bun.sh). Run every test with `bun test`; mod tests run with `claude plugin test mods/<name>`.
