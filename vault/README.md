# Agent-memory vault

A pattern and starter template for a plain-Markdown git repo that works as long-term memory for you and your AI agents (Claude Code, or any tool that reads `AGENTS.md`). Agents read the vault before they ask you questions, and every task they run leaves a structured log for you to review. It opens fine in Obsidian, but nothing here needs Obsidian.

This folder holds only the concept and the templates. Your own vault is a separate, **private** repo that you create from `template/`, a working skeleton: protocol, note format, scripts to validate, capture, search and commit, a pre-commit hook, a Claude Code hook, two skills and one example log. The scripts use only Bun and git: no npm packages, no network calls, no remotes.

## How it works

- **One note format.** Every note starts with frontmatter (`updated`, `tags`, `type`) followed by `## Summary`, `## Notes` and `## Related`, so scripts and agents can parse any note the same way. See `template/_format.md`.
- **Two kinds of memory.** *Episodic* notes are raw and dated: agent task logs and monthly decision logs. *Semantic* notes hold current, distilled facts, one note per project, machine or concept. Agents write episodic notes as they work. Afterwards the useful facts are folded into semantic notes as dated bullets, and old logs are archived.
- **Every agent task gets a log** in `agents/<agent>/reports/`. It starts `active` and ends `completed` (or `error`, `blocked`, `awaiting-approval`). A completed log must list the checks the agent ran and what they returned. The agent sets `verified: false`; only you flip it to `true`. See `template/AGENTS.md`.
- **Git is the safety net.** A pre-commit hook rejects malformed logs, and every change is a commit you can inspect or undo. Everything stays local.

## Requirements

- git (on Windows, Git for Windows, which provides Git Bash)
- [Bun](https://bun.sh) 1.3 or newer for the scripts

## 1. Create your vault from the template

```bash
git clone https://github.com/jz-wilson/claude-setup
cp -r claude-setup/vault/template my-vault
cd my-vault
git init -b main
git config core.hooksPath .githooks
bun run validate                  # logs: ✓ 1 files validated; notes: ✓ 0 files validated, ✓ links ok
git add -A && git commit -m "Vault skeleton"
```

`core.hooksPath` is set per clone, so run it again after every fresh clone of your vault.

The empty folders carry a `.gitkeep` because git tracks files, not folders. Without one, a fresh clone would be missing that folder.

The pre-commit hook has to keep its executable bit on macOS and Linux. If you copied the template from a zip rather than a clone, run `chmod +x .githooks/pre-commit` once.

## 2. What's in the template

| File | Role |
|---|---|
| `AGENTS.md` | The protocol agents follow: scope, "search the vault before asking", task lifecycle, formatting, folder roles |
| `CLAUDE.md` | One line, `@AGENTS.md`, so Claude Code loads the protocol |
| `_format.md` | Note template, field rules, memory tiers, and the agent-log schema |
| `vault.config.json` | Which folder holds which note type; `index.ts`, `capture.ts` and the validators read it |
| `scripts/` | The tooling below, with tests (`bun run test`) |
| `.githooks/pre-commit` | Validates staged logs and notes, checks every relative link in the vault, and regenerates `index.md` for the folders the commit touches |
| `.claude/settings.json` | Claude Code hook that validates a log the moment the agent writes it. On errors it exits 2, so Claude sees them and fixes the log in the same turn |
| `.claude/skills/` | `new-agent-log` (scaffold and close a log) and `wrap-up` (close out a session) |
| `.gitignore` | Keeps the machine-local `SYSTEM.md` and attachments under `personal/` out of git |
| `agents/claude-code/reports/2026-01-01-vault-setup.md` | An example completed log that passes the validator |

To see the hook work, delete the `### Verification` section from the example log, then `git add -A && git commit -m test`. The commit is refused, and the error names the file, the line and the missing section.

### Scripts

Run them from the vault root, as `bun run <name>` or `bun scripts/<file>.ts`. `capture`, `consolidate`, `search`, `commit-task` and `move` print their usage with `--help`.

| Command | What it does |
|---|---|
| `validate` | `validate-logs.ts` then `validate-vault.ts`: frontmatter, enums and real dates, one H1, `## Summary` / `## Notes` / `## Related` in order, no absolute paths, and (full scan) every relative link resolves. `validate-vault.ts --links` checks links only |
| `capture` | `--type project --note demo "fact"` appends `- YYYY-MM-DD: fact` to `projects/demo.md`, bumps `updated:`, creates the note if missing, and restores the file if the result fails validation. Episodic types (`--type decision "…"`) go to `decisions/YYYY-MM.md` |
| `consolidate` | Lists completed logs that link a semantic note older than the log (facts not folded in yet). Lists logs completed more than 90 days ago; `--apply` moves them to `archive/` with `git mv` and rewrites every link to and from them |
| `index` | Regenerates `index.md` in each configured folder (or the ones named), grouped by type |
| `search` | BM25 keyword search over the notes, rebuilt on each run. Prints `path:line: snippet`. Skips `personal/`, notes marked `restricted: true`, and agent logs |
| `dashboard` | Prints live logs grouped by status: needs you, errors, active, completed but unverified. `--write` also regenerates `dashboard/agent-status.md` |
| `stale` | Lists `active` and `blocked` logs older than 30 days; `--apply` closes them as `error` with an Error Log entry |
| `commit-task` | `<log>`: validates a completed or failed log, commits it with the files in its `files:` list (or every changed file), then records the SHA in the log's `commits:` |
| `move` | `<from> <to>`: moves a note and rewrites every inline link that touches it (link titles are dropped; reference-style `[r]: path` definitions are not rewritten) |

## 3. Daily loop

1. **Work.** The agent starts a log with the `new-agent-log` skill and records what it does.
2. **Capture.** Each lasting fact goes into its semantic note with `bun run capture --type <type> --note <name> "<fact>"`. Decisions: `bun run capture --type decision "Chose X over Y because Z"`.
3. **Close.** The agent fills `### Verification`, sets `completed`, and runs `bun run commit-task <log>`.
4. **Review.** `bun run dashboard` lists completed logs you haven't checked. Read each one's Verification section, then flip it to `verified: true`.
5. **Consolidate**, weekly or so. `bun run consolidate` lists logs whose facts haven't reached a semantic note; capture them. `bun run consolidate --apply` archives logs older than 90 days. `bun run stale` catches logs left `active`.

Keep a gitignored `SYSTEM.md` on each machine (shell, tool versions, install paths). Agents read it only when a command depends on the machine.

## Growing it

Still not included, roughly in the order worth adding:

1. Root notes that agents load on demand: who you are and how you like to work; your tech inventory (decided, ruled out, pinned); a glossary of vault terms; a routing contract that says where each kind of fact lives.
2. Semantic search over the notes, next to the keyword `search`. Exclude `personal/` and any other sensitive folder from the index, then test it: a term that appears only in a sensitive note must not come back.
3. A nightly job that runs `bun run validate`, `bun run stale` and `bun run consolidate`, and opens a PR with fixes instead of committing to `main`.

## Privacy rules worth writing down early

- `personal/`, and anything like it, never goes to a third-party API, a public repo, a shared notebook or an external search index.
- Secrets never go in the vault, not even in `personal/`. Keep them in a password manager and record only the item's name.
- Absolute paths in notes leak your username and break on other machines. That's why the validator rejects them.
