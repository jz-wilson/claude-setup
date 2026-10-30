# Review and verification loop

An agent that reviews its own change tends to confirm it. This loop separates the roles: one agent writes, a fresh one reviews, and another checks each finding before anything is fixed or reported.

## The loop

1. **Write the change** and run the real checks (tests, build, a live run). Record the commands and what they returned.
2. **Independent review.** A fresh reviewer (a sub-agent, or Claude Code's `/code-review`) gets **only the diff and the requirements**: not your reasoning, not your conclusion. Ask for concrete findings: file and line, a failing input or scenario, and a confidence from 0 to 100%. Ask it to skip style.
3. **Verify each finding.** A separate agent gets the code and the claim, not the reviewer's reasoning, and answers TRUE or FALSE with the line it saw. Cheap and fast is fine here: each claim is narrow. You can also verify directly with a test that reproduces the failure.
4. **Act on what holds up.**
   - Confirmed correctness findings: fix them, and re-run the reproduction to show it now passes.
   - A finding the reviewer rated under 50% that nobody verified: report it as "unverified, not acted on".
   - A finding your own evidence contradicts: say so and show the evidence. For example: "the task-quoting claim; the test task ran with exit 0".
5. **Stop after two rounds** of fix and review with no progress. Report what is left rather than looping.
6. **Record it.** Put the review, what you fixed, and what you deliberately left in the task's log or PR description.

## Prompts

Reviewer:

```text
Code review, read-only; do not edit files.
Diff: <path to diff, or "git diff main...HEAD" in <repo>>
Requirements: <what the change must do, as a numbered list>
Find correctness bugs: wrong results, broken paths or quoting, data loss, portability, instructions that fail
as written. Ignore style. For each finding: file:line, a concrete failing input or scenario, confidence 0-100%.
Under 400 words. If nothing is wrong, say so.
```

Verifier:

```text
Read-only check; do not edit anything. For each claim answer TRUE or FALSE and cite the file:line you saw.
1. <claim, stated as a checkable fact>
2. ...
Under 150 words.
```

Keep the reviewer on a capable model; a missed finding is never recovered later. The verifier can be the cheapest model, because each claim is small and checkable.

## Enforce it: review-gate

[`scripts/review-gate.ts`](scripts/review-gate.ts) is a `Stop` hook. It reads the session transcript, and if the session edited a code file but no review happened after the first edit, it blocks the stop once with a reminder. A review here means `/code-review` or a sub-agent whose prompt asks for a review of the diff or changes. The second stop is let through, so a trivial edit can be explained and the agent never loops. Edits under scratch or temp folders don't count. `REVIEW_GATE=0` turns it off.

Copy `scripts/review-gate.ts` to `~/.claude/hooks/`, then add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "bun \"$HOME/.claude/hooks/review-gate.ts\"", "timeout": 10 }] }
    ]
  }
}
```

Tests: `bun test review/`.

## Why it is worth the tokens

- A reviewer that sees only the diff and the requirements catches what the author's framing hides: the gap between "it works for the case I tried" and the requirement.
- Reviewers produce confident false positives. Verifying before fixing keeps you from "fixing" working code, and verifying before reporting keeps the user's trust.
- The record of what was found, fixed and left makes the next session, or the human, start from facts.
