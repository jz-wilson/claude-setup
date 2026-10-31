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

## Rebuild spec

Enough to rebuild `scripts/review-gate.ts` from this file alone so that `scripts/review-gate.test.ts` passes. Runtime is Bun and TypeScript, one file, reading one file with `node:fs`.

### Exported function

| Name | Signature | Returns |
|---|---|---|
| `needsReview` | `(transcript: string) => string \| null` | The first offending code-file path, or `null` when the gate passes |

`transcript` is the whole session transcript as text: one JSON object per line, lines joined by newline.

### Run as a hook

The hook steps run only when the file is executed directly (`import.meta.main`), never on import, so the test can import `needsReview`. Input: JSON on stdin (read it whole, e.g. `await Bun.stdin.text()`) with `transcript_path` (read as UTF-8) and `stop_hook_active`. Steps, in order:

1. If env `REVIEW_GATE` is exactly `0`, exit 0.
2. Parse stdin. If `stop_hook_active` is truthy, exit 0.
3. Read the file at `transcript_path` and call `needsReview`.
4. If it returned a path, write one line to stderr: `review-gate: this session edited code (first: <path>) and has no independent review.` followed by guidance to run `/code-review` or a reviewer subagent, fix correctness findings, record them in the log, or say why the edit is trivial. Exit 2.
5. Otherwise exit 0.

| Exit code | Meaning |
|---|---|
| 0 | Pass: gate disabled, second stop, no code edit, or a review found |
| 2 | Block: code edited with no review after it |
| 1 | Crash: empty or invalid stdin JSON, or an unreadable `transcript_path`. These are not caught; Claude Code treats a non-0, non-2 exit as a hook error and lets the stop through |

### Reading the transcript

- Skip any line that contains neither the text `"tool_use"` nor `command-name`.
- Parse each other line as JSON. Skip a line that fails to parse (a torn last line).
- An entry has `type` and `message.content`.
- Tool calls: `assistant` entries whose `content` is an array. Each block with `type` `tool_use` has `name` and `input`.
- Typed text: `user` entries. `content` is a string, or an array whose `text` blocks are joined by newline. `tool_result` blocks are not typed text.

### Edits that count

- Tools: `Edit`, `Write`, `MultiEdit`, `NotebookEdit`.
- Path: `input.file_path`, else `input.notebook_path`, else empty.
- Only the first qualifying edit is recorded, in transcript order (lines top to bottom, blocks left to right). Later edits do not change the result.

A path qualifies only when both hold:

- It ends in one of these extensions, case-insensitive: `ts tsx js jsx mjs cjs py go rs sh ps1 psm1 java kt rb cs c cc cpp h hpp lua sql yaml yml tf hcl`. Anything else (`.md`, `.json`, `.html`, `.css`, `.txt`) is not code.
- It has no path segment named `scratchpad`, `Temp` or `tmp` (case-insensitive), with a `/` or `\` on each side of the segment. Transcripts carry absolute paths, so a relative `scratchpad/a.ts` (no leading separator) is deliberately not exempt.

### What counts as a review

A review counts only if it comes after the first recorded edit. Any one of these ends the scan with `null`:

| Evidence | Rule |
|---|---|
| Typed command | A `user` entry whose typed text contains `<command-name>/code-review`. Tool results do not count. |
| Skill | A `Skill` call whose `input.skill`, at the start or right after a `:`, reads `code-review` followed by a word boundary (regex `(^\|:)code-review`). Covers plugin prefixes such as `plugin:code-review`. |
| Subagent | An `Agent`, `Task` or `Workflow` call whose `input.prompt`, then newline, then `input.script` (missing counts as empty), matches the review-prompt rule below. |

Review-prompt rule (case-insensitive): the text matches `code[- ]review` or the whole word `reviewer` (`reviewer`); or it contains a word starting with `review` (`review`) and also one of the whole words `diff`, `correctness`, `change`, `changes` (`(diff|correctness|changes?)`, so `diffs` does not count).

### Output

- `needsReview` returns the first recorded path when no review follows it.
- It returns `null` when there is no qualifying edit, or when a review follows the edit.

### Tests and what they assert

Tests check return values only: `null`, or the exact path string. No test matches any reason or stderr text.

| Test | Spec line that implies it |
|---|---|
| no edits passes | Only qualifying edit tools set a path; `Read` is ignored, so result is `null` |
| markdown-only edits pass | `.md` is not in the extension list |
| scratchpad code edits pass | Scratch segment rule, with Windows backslash paths |
| code edit without review blocks | Returns the first code path |
| yaml edit without review blocks | `yaml` is in the extension list |
| code-review skill after edit passes | Skill rule, `input.skill` = `code-review` |
| typed /code-review after edit passes | Typed-command rule |
| a tool result echoing /code-review does not count | Tool results are not typed text |
| reviewer subagent after edit passes | Subagent rule; prompt "Review this diff..." matches |
| review before the first edit does not count | Review counts only after `firstEdit` |
| a subagent that merely mentions review does not count | Review-prompt rule: "review" alone is not enough |
| non-review subagent does not count | Review-prompt rule: no match |
| a torn last line is skipped | Unparseable lines are skipped |

Derivable from this spec but not asserted by any test: `MultiEdit`, `NotebookEdit`, `notebook_path`, `Task` and `Workflow` tool names, plugin-prefixed skill names, `stop_hook_active`, `REVIEW_GATE`, exit codes, the stderr text, and "first edit only".
