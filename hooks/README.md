# Guard hooks

Instructions tell the agent what to do; hooks make sure it happens. A hook is a command Claude Code runs at a fixed point (before a tool call, after a file write, when the agent tries to stop). It can block the action and tell the agent why. Use hooks for the few rules where one slip is expensive: leaking a secret, committing after a failed step, ending a task without review.

## Three hook points worth using

| Event | Use it for | How it blocks |
|---|---|---|
| `PreToolUse` | Refuse a command before it runs (secrets, unsafe chains) | Print a JSON `deny` decision with a reason; exit 0 |
| `PostToolUse` | Check a file right after the agent writes it (schemas, lint) | Exit 2 with the errors on stderr; the agent sees them and fixes the file in the same turn |
| `Stop` | Gate the end of a task (no review, no tests run) | Exit 2 with the reason on stderr; the agent keeps working. Let the second attempt through (`stop_hook_active`) so it can never loop |

A good block message says what was wrong **and what to do instead**. The agent reads it and adapts; a bare "denied" just makes it try a workaround.

## shell-guard

[`scripts/shell-guard.ts`](scripts/shell-guard.ts) is a `PreToolUse` hook for `Bash` and `PowerShell` with three rules:

1. **Secret CLIs.** It denies subcommands that print a secret into the transcript (`gh auth token`, `op read`, `vault kv get`…) unless the output goes somewhere other than the transcript. Allowed: captured into a variable (`TOKEN=$(gh auth token) cmd`), passed as an argument (`curl -H "Bearer $(gh auth token)"`), piped to a consumer (`gh auth token | docker login --password-stdin`), or redirected to a file. Still denied: piping it to `cat`, `jq` or `tee`, or echoing it. The transcript is stored, so a printed secret is a leaked secret. Edit `SECRET_COMMANDS` for the tools you use.
2. **Environment.** It denies printing upper-case variables whose names end in a secret word (`GITHUB_TOKEN`, `DB_PASSWORD`, `OPENAI_API_KEY`…) with `echo`, `printf` or `printenv`, and unfiltered dumps such as a bare `env` or `printenv`. Passing the variable to a command (`curl -H "Bearer $GITHUB_TOKEN"`), testing it with `[ -n "$TOKEN" ]`, and filtered dumps (`env | grep PATH`) are allowed.
3. **Chaining.** A multi-line Bash command with `git commit` or `git push` must start with `set -e` or join its lines with `&&`. Otherwise a failed test or build on line 2 still lets the commit on line 3 run.

It parses the command with a small shell scanner, [`scripts/shell-parse.ts`](scripts/shell-parse.ts), rather than a regex. That way it sees through `bash -c '…'`, `$(…)`, pipes and `timeout`, and ignores the same words inside a commit message, an `echo '…'` or a quoted heredoc.

It fails closed. If the hook input can't be parsed and it mentions a secret CLI, the command is denied.

## Wiring

Copy `shell-guard.ts` and `shell-parse.ts` from `scripts/` into `~/.claude/hooks/` (any folder works, as long as both files sit together), then add this to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|PowerShell",
        "hooks": [{ "type": "command", "command": "bun \"$HOME/.claude/hooks/shell-guard.ts\"", "timeout": 10 }]
      }
    ]
  }
}
```

On Windows, Claude Code runs hook commands through Git Bash, so `$HOME` works there too. Requires [Bun](https://bun.sh).

## Test every rule

A guard that misfires gets disabled, and one that silently passes is worse than none. Keep a test next to each hook, with both sides for every rule: what it must deny and what it must let through.

```bash
bun test hooks/
```

Then check it end to end. Pipe a fake hook input in and look for the `deny`:

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"gh auth token"}}' | bun hooks/scripts/shell-guard.ts
```

## Ideas for more

- **Read guard:** deny `cat`/`head`/`sed` of whole files through the shell and point at the agent's file-read tool, which shows line numbers and respects size limits.
- **Size guard:** deny reading files above N lines in one go; ask for a targeted range instead.
- **Web guard:** send fetches of sites that block bots to a tool that handles them.
- **Review gate:** a `Stop` hook that blocks ending a session that changed code without a review. See [../review/](../review/README.md).
