---
updated: 2026-10-30
tags: [meta, agents]
type: concept
---

# Agent Protocol

## Summary
Operating protocol for every AI agent working in this vault (Claude Code, or any AGENTS.md-aware tool). Every task leaves a structured log, so the human can see what each agent did, what it checked, and what still needs review.

## Notes

### Workspace rules

1. Your scope is this vault. Do not modify files outside `agents/<your-agent-name>/` unless the user asks.
2. Task logs go in `agents/<your-agent-name>/reports/`, named `YYYY-MM-DD-short-task-description.md` (lowercase, hyphenated). Use a lowercase agent name such as `claude-code`. Create the folder on first use.

### Ground in the vault before asking

This vault is the owner's knowledge base: infrastructure, projects, decisions, people and preferences. Before asking the user a factual question, search the vault (`grep -r`, or semantic search if configured) and read the matching notes under `infrastructure/`, `projects/`, `decisions/`. Bring the user only genuinely open decisions; never ask about, or recommend against, what the vault already records.

### Vault notes may be stale

Treat notes about live systems as hints. Verify against the system itself before acting on them, and update the note in the same session if it is wrong.

### What to load

Load each file only when its condition applies:

| File | When |
|---|---|
| `_format.md` | Before writing or editing any note |
| `SYSTEM.md` | A command depends on this machine (shell, tool versions, paths). Machine-local and gitignored, so it may be missing |
| `infrastructure/`, `projects/`, `decisions/` notes | Grounding a factual question: search first, read only the matches |

Do not browse `personal/` or other agents' logs unless the task targets them.

### Task lifecycle

Schema: the Agent Log Extension in [_format](_format.md).

1. **Start**: create the log with `status: active` before doing the work.
2. **Failure**: `status: error`, `error_class: transient|permanent`, and an `## Error Log` section.
3. **Blocked**: `status: blocked`; say in the body what is needed. Restore `active` when unblocked.
4. **Human gate**: `status: awaiting-approval`; put the decision context in the body.
5. **Success**: fill `### Verification` under `## Notes` with each check you ran and its result (command → output). Then set `status: completed`, `completion_signal: true`, `verified: false`, and commit. Only a human flips `verified` to `true`.

After writing or updating a log, run `bun scripts/validate-logs.ts` and fix every error. The `new-agent-log` skill scaffolds a log; `bun scripts/commit-task.ts <log>` commits a finished one.

### Recording facts

- Add a fact to a note with `bun scripts/capture.ts --type <type> [--note <name>] "<fact>"`, not by hand: it bumps `updated:`, creates the note if needed and validates it.
- Search before asking: `bun scripts/search.ts <terms>` (it never returns `personal/`).
- `bun scripts/consolidate.ts` lists logs whose facts haven't reached a semantic note yet.

### Formatting

- Markdown only, no HTML. Internal references are relative links, `[text](relative/path.md)`; never absolute paths or `file://` URLs (code fences are exempt).
- Sections: H1 title, `## Summary`, `## Notes`, `## Related` (each link followed by `—` and a short context phrase).
- Logs older than 90 days move to `agents/<your-agent-name>/reports/archive/`.

### Vault structure

| Path | Purpose |
|---|---|
| `agents/` | Agent task logs |
| `decisions/` | Monthly decision logs (`YYYY-MM.md`), one dated bullet per decision |
| `infrastructure/` | Facts about machines, networks, services |
| `projects/` | One note per project; source code lives in its own repo |
| `personal/` | Sensitive. Agents may read and write it, but never publish it, send it to a third-party API, or index it in an external service |
| `scripts/` | Vault tooling |

## Related
- [_format](_format.md) — note format and the agent-log schema
