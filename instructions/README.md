# Global instructions

How to lay out the instruction files Claude Code loads on every session, so the rules you want everywhere are shareable and the personal ones stay private.

## The layers

| File | Loaded | Holds |
|---|---|---|
| `~/.claude/CLAUDE.md` | Every session, every project | Only imports, plus rules you learned from corrections |
| `~/.claude/AGENTS.md` | Imported by the line above | Generic working rules: safe to publish, safe to copy to a work machine |
| `~/.claude/private.md` (any name) | Imported, if it exists | Personal facts: your machines, your secret store, your notes repo, names. Never committed to a shared repo |
| `<project>/CLAUDE.md` | Sessions in that project | `@AGENTS.md`, pointing at the project's own protocol (see [../vault/](../vault/README.md)) |

`CLAUDE.md` pulls the other files in with `@path` lines:

```text
@AGENTS.md
@~/.claude/private.md
```

When an imported file doesn't exist, Claude Code skips it. So the same `CLAUDE.md` works on a machine that has the private file (your own) and on one that doesn't (a work laptop, a fresh install).

Why `AGENTS.md` and not everything in `CLAUDE.md`: other agent tools read `AGENTS.md`, and keeping the rules in one importable file lets you copy or publish them without touching the personal layer.

## What goes where

- **AGENTS.md (generic):** how to communicate, when to act versus ask, planning and verification, coding guardrails, shell and commit safety, research habits. If a rule names your username, a hostname, a vault, a person or a service you use, it belongs in the private file.
- **private.md (personal):** where machine facts live, which secret store to use and its item names, your notes repo path, preferred browser tooling, OS-specific quirks of your machines.
- **CLAUDE.md:** imports, and a short "Rules from corrections" list. When you correct the agent and the correction should stick, add one line with the date. Promote it into `AGENTS.md` once it has proven itself.

## Starter files

- [AGENTS.md](AGENTS.md): the generic rules I use, ready to copy to `~/.claude/AGENTS.md` and edit.
- [CLAUDE.md](CLAUDE.md): the import lines and a sample corrections list.

## Writing rules that work

- **State the rule and the reason.** "Chain dependent commands with `&&` so a failure stops the commit" survives edge cases better than "use `&&`".
- **Name the trigger.** "Before any credential use, load the secret-store skill" fires; "be careful with secrets" doesn't.
- **Say what to do, not only what to avoid.** Every "never" should come with the alternative.
- **Enforce the ones that matter with hooks.** An instruction can be forgotten mid-task; a hook can't. See [../hooks/](../hooks/README.md).
- **Keep the always-loaded files short.** Put detail in skills or docs that load on demand, and leave a one-line pointer in `AGENTS.md`.
