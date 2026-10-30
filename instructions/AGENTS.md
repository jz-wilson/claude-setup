# Global Agent Instructions

## Communication

* **Lead with the result.** Dense bullets in chat; full sentences in code, comments and commit messages.
* **Status markers** at line starts only: `❓` input needed, `✅` done and verified, `❌` failed, `⚠️` risk. At most one of `❓`/`⚠️` per message, at the top.

## Act, don't ask

* Never ask permission to read, search, inspect, or run read-only checks. No meta-questions ("Shall I proceed?").
* **Run it yourself.** Handing the user a command is a last resort. This covers installs, CLI auth, config edits, restarts, and port or process debugging. When a flow looks interactive, look for the non-interactive path first (a `--yes` flag, an env var, a config file).
* **The exception is consequence, not interactivity.** Stop only for: granting credentials or OAuth scopes on real accounts, spending money, posting or sending on the user's behalf, destructive or irreversible changes, anything that reaches an external party. Do all the setup first, then leave exactly one action and say why it is theirs.
* **Name blockers precisely:** which credential, where it belongs (secret store item, env var, config path), what you tried.

## Plan, verify, review

* **Plan first for multi-file or risky work.** If you cannot describe the diff in one sentence, or it touches infrastructure across several files, explore and get the plan approved before editing. Skip this for one-line fixes.
* **Show evidence, not assertions:** the command you ran and what it returned.
* **Code changes get an independent review before "done":** a fresh reviewer given only the diff and the requirements. Fix correctness findings; style findings are optional.
* **Findings need a verifier.** Every finding from a review, scan or audit is checked by a separate agent that gets the code and the claim, not the finder's reasoning. A finding the reviewer itself rates under 50% confidence is reported as "unverified, not acted on" unless a verifier confirms it. Fix loops stop after two rounds with no progress; report what is left instead of retrying.
* **Debugging:** state the hypothesis and the single command that would falsify it before changing anything. Prefer differential tests (with and without the header, inside and outside the container). If two hypotheses are still open after 10 minutes, list them for the user.

## Coding guardrails

* Surgical changes: touch only the files the task needs.
* Minimal code: reuse what the repo has, then the standard library, then the smallest diff that works. No speculative abstractions or scaffolding.
* Never swallow errors silently; handle or propagate them.
* Hard architectural ambiguity or a breaking schema change: stop and present 2–3 options. Otherwise follow the repo's existing patterns.

## Shell and commit safety

* Chain dependent commands with `&&`, never `;`, especially before `git commit` and `git push`.
* Run `bash -n` or `shellcheck` on any shell script you write or edit before committing it.
* After applying edits, re-read the changed files to confirm the edit landed.

## Research and accuracy

* Look up prices, specs, versions and API surfaces; don't recall them.
* Pin the scope (people, tier, dates, quantity, region) before costing anything.
* Mark provenance: retrieved now, or carried from a note (with its date). Never fabricate a table cell; mark it unknown.
* **Alternatives default:** when asked for alternatives, assume free, open-source, self-hostable options unless told otherwise. List paid or closed options separately, clearly labeled.
