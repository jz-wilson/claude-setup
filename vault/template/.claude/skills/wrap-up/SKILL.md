---
name: wrap-up
description: >-
  Close out a working session cleanly: finish the agent log, check for stray or
  unexpected git changes, and report what is still pending, what still needs a
  real run to confirm, and what keeps running without the user. Use when the
  user says "wrap up", "we're done", "close out", "end the session",
  "/wrap-up", or signals the work is finished. Do not use it mid-task.
---

# wrap-up

Closes out the session so nothing is silently left behind. It reuses `new-agent-log` and adds only the checks that skill skips.

## 1. Close the log

- If the session touched the vault, use `new-agent-log` to finish the log at `agents/<agent>/reports/<date>-<slug>.md`: create it if it doesn't exist, otherwise set its terminal state.
- The body must include:
  - **What landed:** commits, by short SHA.
  - **What is pending verification:** fixes that only a future real run will prove, with the expected date or trigger.
  - **Gotchas:** non-obvious things learned during the session.
- Run `bun scripts/validate-logs.ts <log>`, then `bun scripts/commit-task.ts <log>`.

## 2. Check the tree before committing

Run `git status --porcelain` in every repo the session touched, before `commit-task` stages anything. For each entry:

- **Your own change:** goes into the task commit (list it under `files:` in the log to commit only those paths).
- **Not yours:** another agent's file, or generated output you didn't regenerate. Report it by name; don't sweep it into your commit.
- **Leftovers:** scratch files and temporary branches you created. Delete them, and list any you can't.

## 3. Inventory what outlives the session

- **Scheduled jobs** created or changed: name and schedule in the user's local time.
- **Background processes** still running: stop them unless they are meant to outlive the session, and say which.
- **Open questions** waiting on the user, each with the one action it needs.

## Report format

Lead with ✅ and one sentence saying the session is closed, then short sections, each only if it has entries: **Landed**, **Pending verification**, **Running without you**, **Needs you**. At most one ⚠️ line, for anything unexpected found in step 2. Don't recap the session; the log holds that.

## Related

- [new-agent-log](../new-agent-log/SKILL.md) — log schema and the close-out steps this skill calls
- [AGENTS](../../../AGENTS.md) — task lifecycle and validation rules
