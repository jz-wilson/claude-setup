---
name: new-agent-log
description: >-
  Scaffold and maintain a schema-compliant agent log for this vault. Use at the
  START of any vault task (per AGENTS.md, a log must exist with status: active
  before work begins), and whenever a task moves to completed, error, blocked or
  awaiting-approval. Triggers on "start an agent log", "log this task",
  "/new-agent-log", or beginning any non-trivial piece of work in this vault.
  Handles the frontmatter field order, the file path
  (agents/<agent>/reports/YYYY-MM-DD-slug.md), naming rules and the
  completion_signal/verified pairing, so the log passes scripts/validate-logs.ts
  the first time.
---

# new-agent-log

Shortcut for the agent-log schema. The source of truth is the **Agent Log Extension** in [_format](../../../_format.md); the lifecycle is in [AGENTS](../../../AGENTS.md).

## Start: scaffold

```bash
bun .claude/skills/new-agent-log/scripts/scaffold.ts --task "One sentence" --title "Human Readable Title" [--slug short-slug] [--priority high|medium|low]
```

- Writes `agents/claude-code/reports/<today>-<slug>.md` with `status: active`, the frontmatter in canonical order, and empty sections. It prints the path.
- Pass `--title` when the task has acronyms; the auto-title turns "dns api" into "Dns Api".
- Refuses to overwrite without `--force`. `--agent`, `--date` and `--root` override the defaults.
- Then replace the `_(none yet)_` / `_(fill in …)_` placeholders.

## During: edit, never re-scaffold

`status: blocked` or `status: awaiting-approval` with the reason in the body; bump `updated:` on each meaningful edit.

## End: exact field sets

- **Success:** fill `### Verification` under `## Notes` (each check run → its result; for code diffs, the review findings and fixes), then `status: completed`, `completion_signal: true`, `verified: false`. The validator rejects a completed log without real Verification content. Never set `verified: true` on your own log.
- **Failure:** `status: error`, `error_class: transient|permanent`, plus an `## Error Log` section after `## Related`.

Then `bun scripts/commit-task.ts <log>`: it validates the log, commits the log plus the files in its optional `files:` list (or every changed file when there is no list), and records the SHA in `commits:`. Run `bun scripts/validate-logs.ts <log>` after any later edit.

## Traps

- Frontmatter is raw YAML at the very top, never inside a code fence.
- Links are relative Markdown links, e.g. `[AGENTS](../../../AGENTS.md)` from a log; no wiki-links, `file://` URLs or absolute paths.
