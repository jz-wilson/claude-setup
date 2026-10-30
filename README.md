# agent-memory-vault

A pattern and starter template for a plain-Markdown git repo that works as long-term memory for you and your AI agents (Claude Code, or any tool that reads `AGENTS.md`). Agents read the vault before they ask you questions, and every task they run leaves a structured log for you to review. It opens fine in Obsidian, but nothing here needs Obsidian.

This repo holds only the concept and the templates. Your own vault is a separate, **private** repo that you create from `template/`.

| Path | What it is |
|---|---|
| `template/` | A working vault skeleton: protocol, note format, log validator, pre-commit hook, sync script, Claude Code hook, one example log |
| `docs/claude-hud-setup.md` | Unrelated extra: how to set up the claude-hud status line for Claude Code on Windows with Git Bash |

## How it works

- **One note format.** Every note starts with frontmatter (`updated`, `tags`, `type`) followed by `## Summary`, `## Notes` and `## Related`, so scripts and agents can parse any note the same way. See `template/_format.md`.
- **Two kinds of memory.** *Episodic* notes are raw and dated: agent task logs and monthly decision logs. *Semantic* notes hold current, distilled facts, one note per project, machine or concept. Agents write episodic notes as they work. Afterwards the useful facts are folded into semantic notes as dated bullets, and old logs are archived.
- **Every agent task gets a log** in `agents/<agent>/reports/`. It starts `active` and ends `completed` (or `error`, `blocked`, `awaiting-approval`). A completed log must list the checks the agent ran and what they returned. The agent sets `verified: false`; only you flip it to `true`. See `template/AGENTS.md`.
- **Git is the safety net.** A pre-commit hook rejects malformed logs, and a scheduled sync keeps every machine's copy current.

## Requirements

- git (on Windows, Git for Windows, which provides Git Bash)
- [Bun](https://bun.sh) for the scripts
- A **private** remote (GitHub, Forgejo, Gitea…) for your vault. It will hold personal facts.

## 1. Create your vault from the template

```bash
git clone https://github.com/jz-wilson/agent-memory-vault
cp -r agent-memory-vault/template my-vault
cd my-vault
git init -b main
git config core.hooksPath .githooks
bun scripts/validate-logs.ts      # ✓ 1 logs, 0 errors
git add -A && git commit -m "Vault skeleton"
```

`core.hooksPath` is set per clone, so run it again after every fresh clone of your vault.

The empty folders carry a `.gitkeep` because git tracks files, not folders. Without one, a fresh clone would be missing that folder.

The pre-commit hook has to keep its executable bit on macOS and Linux. If you copied the template from a zip rather than a clone, run `chmod +x .githooks/pre-commit scripts/vault-sync.sh` once.

## 2. What's in the template

| File | Role |
|---|---|
| `AGENTS.md` | The protocol agents follow: scope, "search the vault before asking", task lifecycle, formatting, folder roles |
| `CLAUDE.md` | One line, `@AGENTS.md`, so Claude Code loads the protocol |
| `_format.md` | Note template, field rules, memory tiers, and the agent-log schema |
| `scripts/validate-logs.ts` | Checks agent logs: frontmatter fields and enums, real dates, required sections, a non-empty `### Verification` on completed logs, no absolute paths in the body |
| `.githooks/pre-commit` | Runs the validator on staged logs and blocks the commit on errors |
| `.claude/settings.json` | Claude Code hook that validates a log the moment the agent writes it. On errors it exits 2, so Claude sees them and fixes the log in the same turn |
| `scripts/vault-sync.sh` | One two-way sync pass (see step 3) |
| `.gitignore` | Keeps the machine-local `SYSTEM.md` and attachments under `personal/` out of git |
| `agents/claude-code/reports/2026-01-01-vault-setup.md` | An example completed log that passes the validator |

To see the hook work, delete the `### Verification` section from the example log and commit. The commit is refused, and the error names the file, the line and the missing section.

## 3. Private remote and sync

```bash
git remote add origin <your private repo URL>
git push -u origin main
```

`scripts/vault-sync.sh <vault-dir>` does one sync pass:

1. It commits files untouched for 10 minutes (`SETTLE_MINUTES`), so a note you are still typing stays out. The commit still goes through the pre-commit hook.
2. It merges the remote, never rebasing. On a real conflict it aborts the merge, leaves the tree clean with your local commits intact, and exits 1. Resolve that one by hand.
3. It pushes.

Run it every 5 minutes.

**Linux/macOS** (`crontab -e`):

```cron
*/5 * * * * /path/to/my-vault/scripts/vault-sync.sh /path/to/my-vault >> /tmp/vault-sync.log 2>&1
```

**Windows** (Task Scheduler, through Git Bash; `-l` loads your profile so `bun` and your git credentials are found):

```powershell
schtasks /Create /SC MINUTE /MO 5 /TN vault-sync /TR "'C:\Program Files\Git\bin\bash.exe' -lc '/c/path/to/my-vault/scripts/vault-sync.sh /c/path/to/my-vault >> /tmp/vault-sync.log 2>&1'"
```

- `/TR` is capped at 261 characters. With a long vault path, put the call in a short wrapper script and point `/TR` at that instead.
- A console window flashes on each run. To hide it, set the task to "Run whether user is logged on or not" in Task Scheduler.

## 4. Day to day

- **Decisions:** `decisions/2026-01.md` (type `decision`), with one bullet per decision: `- 2026-01-15: Chose X over Y because Z.`
- **Semantic notes:** `projects/<name>.md`, `infrastructure/<host>.md`. When a log produces a lasting fact, append it to the matching note as `- YYYY-MM-DD: <fact>` and bump `updated:`.
- **Machine facts:** keep a gitignored `SYSTEM.md` on each machine (shell, tool versions, install paths). Agents read it only when a command depends on the machine.
- **Review:** `grep -l "verified: false" agents/*/reports/*.md` lists completed logs you haven't reviewed. Read each one's Verification section, then flip it to `verified: true`.
- **Archive:** move logs older than 90 days to `agents/<agent>/reports/archive/` with `git mv`. The validator skips `archive/`.

## Growing it

Once the basics hold, these are worth adding, roughly in this order:

1. A validator for all other notes (frontmatter, section order, relative links that resolve), run from the same pre-commit hook.
2. A `capture` script that appends a dated fact to a semantic note and creates the note if it is missing, so agents never hand-edit frontmatter.
3. A `consolidate` script that lists completed logs whose facts haven't reached a semantic note yet, and archives old reviewed logs.
4. A generated status note, or a small local dashboard, that groups logs by status: active, blocked, errors, and completed but unverified.
5. Root notes that agents load on demand:
   - who you are and how you like to work
   - your tech inventory: what's decided, ruled out or pinned
   - a glossary of vault terms
   - a routing contract that says where each kind of fact lives
6. Semantic search over the notes. Exclude `personal/` and any other sensitive folder from the index, then test it: a term that appears only in a sensitive note must not come back.
7. A nightly job that runs the validators, flags notes that haven't been updated in a long time, and opens a PR with fixes instead of committing to `main`.

## Privacy rules worth writing down early

- `personal/`, and anything like it, never goes to a third-party API, a public repo, a shared notebook or an external search index.
- Secrets never go in the vault, not even in `personal/`. Keep them in a password manager and record only the item's name.
- Absolute paths in notes leak your username and break on other machines. That's why the validator rejects them.
