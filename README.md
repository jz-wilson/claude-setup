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

Scripts need [Bun](https://bun.sh). Run every test with `bun test`; mod tests run with `claude plugin test mods/<name>`.
