---
updated: 2026-10-30
tags: [meta, conventions]
type: concept
---

# Vault Note Format

## Summary
Template and rules for every note in the vault, and the single source of truth for the agent-log schema that `scripts/validate-logs.ts` enforces.

## Notes

### Template

```markdown
---
updated: YYYY-MM-DD
tags: [primary-tag, secondary-tag]
type: concept
---

# Title

## Summary
One or two sentences: what this note is and why it exists.

## Notes
Main content.

## Related
- [Other note](other-note.md) — why it is related
```

### Fields

- `updated`: ISO date; bump on every meaningful edit.
- `tags`: YAML list, at least one; lowercase, hyphenated, no `#`.
- `type`: `decision` (monthly decision log), `project`, `infra`, `concept`, `glossary`, `personal`, `agent-log`, `handoff`.

### Rules

1. Frontmatter is raw YAML at the very top, never in a code fence; fields in the order `updated`, `tags`, `type`.
2. Exactly one H1, directly under the frontmatter.
3. `## Summary`, `## Notes`, `## Related` in that order; write `_(none yet)_` in an empty one.
4. Internal links are relative Markdown links; no absolute paths or `file://` URLs outside code fences.
5. Decision logs: one bullet per decision, starting `YYYY-MM-DD:`.

### Memory tiers

The `type` field also says which kind of memory a note is:

| Tier | What it holds | Types |
|---|---|---|
| Episodic | Raw, dated, append-only records | `agent-log`, `decision` |
| Semantic | Distilled, current facts | `project`, `infra`, `concept`, `glossary` |
| Procedural | Preferences and working habits | The agent's own memory (for Claude Code, its auto-memory directory), not the vault |

Facts flow one way: a log records them while the task runs; afterwards the useful ones are folded into the matching semantic note as dated bullets, and the log can be archived.

### Agent Log Extension

Required, after the three standard fields:

```yaml
agent: "claude-code"   # quoted, non-empty
status: active         # active | blocked | awaiting-approval | completed | error
task: "One sentence describing the task"
priority: medium       # high | medium | low
date: 2026-10-30       # task date
```

`tags` must contain `agent-log`. Optional:

```yaml
completion_signal: true  # agent asserts the task is done; required when completed
verified: false          # required when completed; only a human flips it to true
error_class: transient   # transient | permanent; required when status is error
commits: ["abc1234"]     # SHAs the task produced
model: "<model id>"      # model that did the work
```

Rules:

- `completed` needs `completion_signal: true`, `verified: false`, and a non-empty `### Verification` section under `## Notes` listing each check and its result.
- `error` needs `error_class` and an `## Error Log` section.
- Location `agents/<agent>/reports/`, name `YYYY-MM-DD-slug.md`; after 90 days, move to `reports/archive/`.

## Related
- [AGENTS](AGENTS.md) — the protocol that uses this format
