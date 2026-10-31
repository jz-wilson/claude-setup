# Vault tooling: rebuild specification

This document specifies `scripts/*.ts`, `.githooks/pre-commit` and `.claude/skills/new-agent-log/scripts/scaffold.ts` closely enough that they can be rebuilt without the original code, so that `bun test scripts` passes against the rebuild. It is read together with `../AGENTS.md`, `../_format.md`, `../vault.config.json`, `../package.json`, `../.claude/settings.json`, the example log and the skills' `SKILL.md` files, and the user-level guide `../../README.md`. Where those files already say something (the note schema, the log lifecycle, the npm script names), this document only adds what they leave out.

## Contents

1. [Ground rules](#1-ground-rules)
2. [Module map and dependency direction](#2-module-map-and-dependency-direction)
3. [Shared conventions](#3-shared-conventions)
4. [config.ts and vault.config.json](#4-configts-and-vaultconfigjson)
5. [cli-colors.ts](#5-cli-colorsts)
6. [links.ts](#6-linksts)
7. [frontmatter.ts](#7-frontmatterts)
8. [validate-logs.ts](#8-validate-logsts)
9. [validate-vault.ts](#9-validate-vaultts)
10. [capture.ts](#10-capturets)
11. [move-note.ts](#11-move-notets)
12. [consolidate.ts](#12-consolidatets)
13. [index.ts](#13-indexts)
14. [search.ts](#14-searchts)
15. [dashboard.ts](#15-dashboardts)
16. [commit-task.ts](#16-commit-taskts)
17. [stale-logs.ts](#17-stale-logsts)
18. [.githooks/pre-commit](#18-githookspre-commit)
19. [scaffold.ts](#19-scaffoldts)
20. [test-fixture.ts](#20-test-fixturets)
21. [Test traceability](#21-test-traceability)
22. [Traps](#22-traps)

---

## 1. Ground rules

- Runtime: Bun 1.3 or newer (needs `Bun.YAML`, `Bun.Glob`, `Bun.spawnSync`, `import.meta.dir`, `import.meta.main`). Only `node:` built-ins otherwise. No npm dependencies; `package.json` has none.
- ES modules, TypeScript, imports written with the `.ts` extension (`import { x } from "./links.ts"`).
- Every module that has a CLI guards it with `if (import.meta.main) runMain(main)`, so a test can import the module without side effects. Nothing may run at import time except constant definitions.
- Every CLI derives the vault root from its own location: `vaultRoot = resolve(import.meta.dir, "..")`, never from the current directory. Tests spawn `validate-logs.ts` from an arbitrary cwd and expect it to find `vault.config.json`. Path arguments the user types (log paths, note paths) are resolved against cwd.
- Files are read and written as UTF-8. The tooling writes LF only.
- The tests (`bun test scripts`) use the real files in `scripts/` plus throwaway vaults in the OS temp directory (section 20).
- Suggested build order, bottom up: cli-colors, links, config, frontmatter, test-fixture, validate-logs, validate-vault, capture, move-note, consolidate, index, search, dashboard, commit-task, stale-logs, pre-commit, scaffold.

## 2. Module map and dependency direction

Arrows point from importer to imported. There are no cycles.

```
cli-colors   (leaf)            links   (leaf)           config   (leaf)
frontmatter  -> links
validate-logs  -> frontmatter, config
validate-vault -> frontmatter, config, validate-logs, links
capture      -> cli-colors, frontmatter, config, validate-vault
move-note    -> cli-colors, links, config
consolidate  -> cli-colors, frontmatter, config, validate-logs, links, move-note
index        -> frontmatter, config, links
search       -> frontmatter, config
dashboard    -> cli-colors, config, frontmatter, links, validate-logs
commit-task  -> cli-colors, validate-logs, frontmatter, config
stale-logs   -> frontmatter, config, validate-logs
test-fixture -> config
```

Exports per module (`type` = TypeScript type or interface). Items marked **T** are imported by a test file (directly, or through the fixture); all others are used by other modules or are public API and must still exist.

| Module | Exports |
|---|---|
| `cli-colors.ts` | `colorEnabled: boolean`, `pc` (`bold dim red green yellow cyan`, each `(s: string \| number) => string`), `consola` (`log info success warn error`, each `(...a: unknown[]) => void`) |
| `config.ts` | `builtinEdgeTypes(): Set<string>`, `NOTES_SPLIT_LINES = 150`, `NONCONTENT_SUBTREES: Set<string>`, `RESTRICTED_SUBTREES: Set<string>`, `inSkippedSubtree(rel, skip): boolean`, `toPosix(p): string`, `isRestricted(rel, noteText?): boolean` **T**, `resolveInside(base, rel, label?): string`, `requestedVaultDir(argv): string \| null`, `runMain(main): void`, `loadConfig(vaultRoot): VaultConfig` **T**, `derive(cfg): Derived` **T**, `loadFromScript(importMetaDir): Derived`, types `SnapshotConfig`, `VaultConfig`, `Derived` **T** |
| `links.ts` | `blankCode` **T**, `extractLinks` **T**, `hrefFor` **T**, `isExternal` **T**, `lineIndex` **T**, `mdLink` **T**, `resolveHref` **T**, `slugAnchor` **T**, `splitHref` **T**, `vaultLinks` **T**, `WIKI_LINK_RE` **T**, `canonicalId`, `escapeLinkText`, type `MdLink` |
| `frontmatter.ts` | `DATE_RE`, `INLINE_CODE_RE`, `FENCE_RE`, `splitLines` **T**, `isValidCalendarDate` **T**, `parseFrontmatter` **T**, `extractField` **T**, `fmLineNo` **T**, `extractTagsList` **T**, `extractFmLists` **T**, `extractEdges` **T**, `validateEdges`, `validateCommonNoteShape`, `checkBodyPaths` **T**, `checkRetiredWikiLinks` **T**, `bodyHeadings`, `checkHeadings` **T**, `readFrontmatterFile`, types `ParsedFm`, `LineError`, `Edge`, `NoteShape` |
| `validate-logs.ts` | `validateAgentLog` **T**, `hasVerificationEvidence`, `findAgentLogs` |
| `validate-vault.ts` | `validateVaultNote` **T**, `buildResolver` **T**, `checkLinks` **T**, `isGitIgnoredLinkTarget` **T**, `isUncheckedSubmoduleTarget`, `readNote`, `shouldSkip`, `skipForEdges`, `ROOT_SKIP_FILES`, types `LinkReport`, `LinkRecord`, `LinkResolver` |
| `capture.ts` | `ymd` **T**, `ym`, `resolvePath` **T**, `createNote` **T**, `insertBullet` **T** |
| `move-note.ts` | `planMove` **T**, `applyMove` **T**, types `InboundEdit`, `MovePlan` |
| `consolidate.ts` | `ARCHIVE_THRESHOLD_DAYS = 90`, `dateOrNull`, `todayCalendarDate`, `resolveRelatedLink`, `relatedLinkHrefs`, `findArchivalCandidates` **T**, `archiveLogs` **T**, `findDistillationCandidates` **T** |
| `index.ts` | `notesInDir` **T**, `loadNoteMeta`, `noteSubfolders`, `buildIndex`, types `NoteMeta`, `SubfolderNotes` |
| `search.ts` | `tokenize`, `bm25`, `search` **T**, `loadNotesFromVault` **T**, types `Doc`, `CorpusStats`, `ScoreFn`, `NoteInput`, `Result` |
| `dashboard.ts` | `ARTIFACT`, `collectLogs` **T**, `render` **T**, `renderMarkdown` **T**, type `TaskLog` |
| `commit-task.ts` | `addCommitSha` **T**, `porcelainPaths` |
| `stale-logs.ts` | none (CLI only) |
| `test-fixture.ts` | `makeVault`, `note`, `agentLog`, type `FixtureVault` (all **T**) |

## 3. Shared conventions

- `LineError = [line: number, message: string]`. Line numbers are 1-based file lines. Two special cases: line `0` means "file level" (used only by the two end-of-file newline errors), and a missing frontmatter field is reported at the first frontmatter line (file line 2, called `fmStart`).
- Frontmatter starts at file line 1 (`---`); its first content line is file line 2; the closing `---` is at `closeLineNo`; body lines start at `closeLineNo + 1`.
- Validators return tuples and never throw for content problems: `validateAgentLog` returns `[rel, LineError[]]`; `validateVaultNote` returns `[rel, LineError[], LineError[]]` (errors, then warnings). `rel` is the vault-relative path with forward slashes.
- CLI error line format: `<rel>:<line>: <message>` (warnings: `<rel>:<line>: warning: <message>`).
- All vault-relative paths used for logic are forward-slash paths. Any path coming from `Bun.Glob`, `path.relative` or `path.join` is passed through `toPosix` before it is compared, split or matched (on Windows these produce backslashes).
- Messages contain the em dash `—` (U+2014) and in a few places `→`. Use exactly those characters.
- Dates are `YYYY-MM-DD`, matched by `DATE_RE = /^\d{4}-\d{2}-\d{2}$/` and then checked for being a real calendar date. "Today" is the local calendar date, except in `stale-logs.ts` where the stamp uses the UTC date (section 17).
- Sorted sets in messages: `[...set].sort()` (default string sort), each element single-quoted, joined with `, `, wrapped in `[` `]`. Example: `['high', 'low', 'medium']`.
- `runMain(main)` (config.ts) is the common CLI wrapper: it calls `main()`; a thrown error, or a rejected promise returned by it, prints `error: <message>` to stderr and exits 1. A bare `process.exit(n)` inside `main` is allowed and bypasses this.
- Streams: unless stated otherwise, normal output (validator error lines, summaries, `--json`, plan and report lines, `--help` text) goes to **stdout** via `console.log`; `consola.error` and `consola.warn` lines and usage text printed after a usage error go to **stderr**; the Claude hook error lines go to stderr. In particular `validate-logs` and `validate-vault` print every error line, `file not found` line, warning, summary (`✓`/`✗`) and `--json` document to stdout, even on failure; only `--hook` mode writes to stderr. `consolidate` usage text is exactly `Usage: bun scripts/consolidate.ts [--apply] [--archive-only]` followed by a second line `  (dry run by default; --apply moves completed logs older than 90 days into archive/)`.
- Unknown flags, per CLI (`util.parseArgs` is strict, so an unknown flag throws a message whose wording belongs to Bun and is not pinned):
  - `capture`, `consolidate`, `commit-task`, `move-note`: caught; `consola.error(<message>)` then the usage text on stderr, exit 2.
  - `search`: caught; `<message>\n<usage>` on stderr (no marker), exit 1.
  - `scaffold`: not caught; Bun prints the uncaught error, exit 1.
  - `stale-logs` (looks only for `--apply`), `dashboard` (only `--write`): unknown flags are silently ignored, exit as normal.
  - `index`: every argument is a folder name, so a flag-looking argument is just a non-configured folder and is silently ignored.
  - `validate-logs`, `validate-vault`: every argument other than `--hook` (first, logs only) or `--json`/`--links` (vault only) is a file path, so an unknown flag yields the `file not found` line and exit 1.
- Exit codes: validators 0 clean / 1 errors; usage errors 2; unexpected errors (via `runMain`) 1. Claude hook mode exits 2 on errors (section 8).

## 4. config.ts and vault.config.json

### vault.config.json

```json
{ "name": "my-vault",
  "semantic_dirs": { "infra": "infrastructure", "project": "projects", "personal": "personal" },
  "episodic_dirs": { "decision": "decisions" },
  "extra_dirs": [] }
```

| Key | Type | Default when absent | Meaning |
|---|---|---|---|
| `name` | string | `"vault"` | Informational |
| `semantic_dirs` | `{type: dir}` | `{}` | Distilled-fact notes, one note per subject. `capture --type <type> --note <n>` writes `<dir>/<n>.md` |
| `episodic_dirs` | `{type: dir}` | `{}` | Dated logs. `capture --type <type>` writes `<dir>/<YYYY-MM>.md` |
| `extra_dirs` | `string[]` | `[]` | Extra folders that get an `index.md`, not tied to a type |
| `index_style` | `{dir: style}` | absent | `"alphabetical"` gives a flat title-sorted index; any other value or absence means grouped by type |
| `snapshot` | `{files: string[], budget_tokens: number}` | absent | Loaded and path-checked (every `files` entry), otherwise unused by the template |
| `edge_types` | `string[]` | absent | Extra typed-edge vocabulary, unioned with the built-in one |
| `split_notes_lines` | number | absent | Overrides the 150-line `## Notes` warning threshold |

`loadConfig(vaultRoot)` reads `<vaultRoot>/vault.config.json` (throws if missing or invalid JSON), applies the defaults above, and runs the traversal guard: every dir value in `semantic_dirs`, every dir value in `episodic_dirs`, every `extra_dirs` entry and every `snapshot.files` entry must stay inside `vaultRoot`, else it throws `vault.config.json: <label> '<value>' escapes the vault root`, where `<label>` is `semantic_dirs.<type>`, `episodic_dirs.<type>`, `extra_dirs` or `snapshot.files`. `edge_types` and `index_style` are vocabulary, not paths, and are not checked. The returned `VaultConfig` carries `index_style`, `snapshot`, `edge_types`, `split_notes_lines` only when present in the file.

`resolveInside(base, rel, label = "path")` returns `resolve(base, rel)` and throws `Error("<label> '<rel>' escapes the vault root")` unless the result equals `base` or starts with `base + path.sep`. (`base` is an absolute, normalized path such as `vaultRoot`.)

### Derived layout (`derive(cfg): Derived`)

| Field | Value |
|---|---|
| `cfg` | the config itself |
| `TYPE_DIRS` | `{...semantic_dirs, ...episodic_dirs}` |
| `SEMANTIC_DIRS`, `EPISODIC_DIRS` | the two maps as configured |
| `VALID_TYPES` | `Set`: all keys of `TYPE_DIRS` plus the universal types `agent-log, handoff, concept, reference, glossary, personal, skill` |
| `EDGE_TYPES` | `Set`: built-in `depends-on, implements, supersedes, contradicts, evidence-for, part-of, blocked-by, about` plus `cfg.edge_types ?? []` |
| `ALL_DIRS` | `["agents","dashboard","handoffs", ...semantic dir values, ...episodic dir values, ...extra_dirs]` (informational) |
| `NOTES_SPLIT_LINES` | `cfg.split_notes_lines ?? 150` |

`builtinEdgeTypes()` returns a new `Set` of just the eight built-in edge types. `loadFromScript(importMetaDir)` = `derive(loadConfig(resolve(importMetaDir, "..")))`.

### Subtree constants and predicates

- `NONCONTENT_SUBTREES = {".git","node_modules",".claude",".agents","scripts","dashboard"}`: folders no content scanner reads as notes.
- `RESTRICTED_SUBTREES = {"personal"}`.
- `inSkippedSubtree(rel, skip)`: true when **any** `/`-separated segment of `rel` is in `skip` (not only the first), so `projects/x/node_modules/y.md` is skipped.
- `toPosix(p)`: replace every `\` with `/`.
- `isRestricted(rel, noteText?)`: true if `inSkippedSubtree(rel, RESTRICTED_SUBTREES)`. Otherwise, if `noteText` is given and non-empty: strip a leading BOM (U+FEFF), match the frontmatter block with `/^---\r?\n([\s\S]*?)\r?\n---/`, and test that block with `/^restricted:\s*(["']?)true\1\s*(#.*)?$/im`. So `restricted: true`, `True`, `"true"`, `'true'` and `true   # comment` count; `false` does not. No frontmatter or no text means not restricted (path rule only). `rel` must be a forward-slash path.
- `requestedVaultDir(argv)`: the value after `--dir` if present, else `process.env.VAULT_DIR ?? null`. (Public helper, unused by the template CLIs.)

## 5. cli-colors.ts

- `colorEnabled` = `FORCE_COLOR` set and not `"0"`, **or** (`NO_COLOR` unset **and** stdout is a TTY **and** stderr is a TTY). Computed once at import.
- `pc.<name>(s)` returns `String(s)` when colour is off, else `ESC[<open>m<s>ESC[<close>m` with (open, close) = bold (1,22), dim (2,22), red (31,39), green (32,39), yellow (33,39), cyan (36,39).
- `consola.log` prints its arguments to stdout unchanged. `info` prints `pc.cyan("ℹ")` then the arguments to stdout; `success` prints `pc.green("✔")` and the arguments to stdout; `warn` prints `pc.yellow("⚠")` and the arguments to **stderr**; `error` prints `pc.red("✖")` and the arguments to **stderr**. (Each is `console.log/error(marker, ...args)`, so marker and first argument are space-separated.)

## 6. links.ts

Standard Markdown links are the only vault link syntax. A vault link is `[text](path)` where `path` is relative to the directory of the file carrying it, forward slashes, extension included, `../` to climb, case-sensitive. External URLs, `mailto:`, bare `#anchors` and images `![..](..)` are not vault links. Links inside fenced code or inline code are text, not links.

### Regular expressions (exact; the tests depend on their groups)

| Name | Pattern |
|---|---|
| `WIKI_LINK_RE` (global, exported) | `/\[\[((?:[^\]\|#\\]\|\\(?!\|))*)(?:#([^\]\|]*))?(?:\\?\|([^\]]*))?\]\]/g` |
| `MD_LINK_RE` (internal, global) | `/(?<![!\]])\[((?:\\.\|[^\[\]\\]\|\[[^\[\]]*\])*)\]\(\s*(<[^>]*>\|[^\s)]+)(?:\s+(?:"[^"]*"\|'[^']*'\|\([^)]*\)))?\s*\)/g` |

In this table `\|` is a Markdown-table escape for a plain `|`; the real patterns contain an unescaped `|` there. Meaning: `WIKI_LINK_RE` group 1 is the target (possibly empty for `[[#Heading]]`; it stops before an escaped `\|`), group 2 the heading after `#`, group 3 the alias after `|` or `\|`; unmatched groups are `undefined`. `MD_LINK_RE` group 1 is the text (backslash escapes allowed, one level of nested `[ ]` allowed), group 2 the href (angle-bracketed, or no whitespace and no `)`), followed by an optional title in `"…"`, `'…'` or `(…)`; the match must not be preceded by `!` or `]`.

### Functions

| Function | Behaviour |
|---|---|
| `blankCode(text): string` | Same length and same number of lines as `text`, with fenced and inline code replaced by spaces (newlines kept). Process line by line, keeping each terminator. A fence line matches `/^ {0,3}(`{3,}\|~{3,})/` (again `\|` is a table escape). An open fence blanks its own line and every line after it until a fence line with the same character and at least as many marks, which is also blanked; an unclosed fence blanks to the end. Outside fences, inline code `` /`+[^`]*`+/g `` is replaced by equal-length spaces |
| `isExternal(href)` | True if `/^[a-z][a-z0-9+.-]*:/i` matches, or `href` starts with `//` or `#`, or `href === ""` |
| `splitHref(href)` | `{path, anchor}` split at the first `#`; `anchor` is the text after it, `null` when there is no `#` |
| `lineIndex(text)` | `{ lineOf(idx): number }`: 1-based line of a character offset (offsets up to and including the first `\n` are line 1; the character after a `\n` starts the next line). Any implementation |
| `extractLinks(text): MdLink[]` | `MdLink = {text, href, line, index, raw}`. Runs `MD_LINK_RE` over `blankCode(text)`; per match: `href` = group 2 with surrounding `<…>` removed, then `decodeURI` applied (left as is if it throws); `text` = group 1 with escapes undone (`\\`→`\`, `\[`→`[`, `\]`→`]`, one left-to-right pass); `line` = `lineOf(index)`; `index` = offset of the `[`; `raw` = `text.slice(index, index + match.length)` taken from the **original** text. External links and bare anchors are included. Document order |
| `vaultLinks(text)` | `extractLinks(text)` filtered by `!isExternal(href)`, each extended with `{path, anchor}` from `splitHref(href)` |
| `resolveHref(fromRel, href)` | `null` if `isExternal(href)`, or if the path part is empty or starts with `/`. Else `dir = dirname(fromRel with \ replaced by /)` (`"."` treated as empty), `n = posix.normalize(posix.join(dir, path))` with a leading `./` removed; return `null` if `n` is `..`, starts with `../`, or is absolute; return `""` if `n` is `.`; else `n`. Trailing slashes survive (`projects/sub/` stays `projects/sub/`). The anchor is ignored |
| `hrefFor(fromRel, targetRel)` | Relative path from the directory of `fromRel` to `targetRel`, forward slashes, no leading `./`; if that is empty, `basename(targetRel)`. Compute it lexically, not through the process cwd. `hrefFor("projects/x.md","projects/y.md") = "y.md"`; `hrefFor("projects/x.md","AGENTS.md") = "../AGENTS.md"`; `resolveHref(from, hrefFor(from, t)) === t` |
| `canonicalId(rel)` | Replace `\` with `/` and strip a trailing `.md` (case-insensitive) |
| `slugAnchor(heading)` | `heading.trim().toLowerCase()`, delete every character that is not a Unicode letter, Unicode number, whitespace, `_` or `-` (`/[^\p{L}\p{N}\s_-]/gu`), then replace each single whitespace character with `-` (runs are not collapsed). `"Typed Edges"`→`typed-edges`; `"  What to load? (v2) "`→`what-to-load-v2`; `"my_heading  two"`→`my_heading--two`; `"a___b"`→`a___b`; `"🎉 Party"`→`-party`; `"Héllo, wörld! 2026"`→`héllo-wörld-2026` |
| `escapeLinkText(text, escapePipe=false)` | Prefix `\` before every `\`, `[` and `]`; if `escapePipe`, then also turn every `|` into `\|` |
| `mdLink(text, fromRel, targetRel, anchor?, escapePipe=false)` | `[<escapeLinkText(text, escapePipe)>](<href>)` with `href = hrefFor(fromRel, targetRel)` plus `#<anchor>` when `anchor` is truthy; the href is wrapped in `<…>` if it contains whitespace, `(` or `)`. `mdLink("nodes","projects/x.md","infrastructure/nodes.md")` = `[nodes](../infrastructure/nodes.md)`; anchor `typed-edges` → `[f](_format.md#typed-edges)`; target `personal/my report.pdf` → `[r](<personal/my report.pdf>)`; text `a|b` stays `[a|b](y.md)` by default; with `escapePipe` a single backslash is inserted before the pipe (the JS string `"[a\\|b](y.md)"`). `extractLinks(mdLink(t, …))[0].text === t` for `C:\`, `Notes [draft`, `a]b`, `x [y] z`, `back\slash` |

## 7. frontmatter.ts

All functions work on arrays of lines with no newline characters.

### Line splitting and structure

- `splitLines(text)`: drop a leading BOM (U+FEFF); split on `\n`; strip one trailing `\r` from each line; if the last element is `""`, drop it (once). `""` gives `[]`.
- `parseFrontmatter(lines): ParsedFm | null`, `ParsedFm = {fm, body, closeLineNo}`: `null` unless `lines[0] === "---"` exactly; the closing delimiter is the first later line that is exactly `---`; `null` if none. Returns `{fm: lines between, body: lines after the closing one, closeLineNo: index of closing + 1}`.
- `readFrontmatterFile(path)`: `parseFrontmatter(splitLines(file text))`, `null` if the file cannot be read or has none.
- `isValidCalendarDate("YYYY-MM-DD")`: true only for real dates (2026-02-28 true; 2026-02-30 and month 13 false). Build a UTC date and compare the parts back.

### Scalar and list fields

- `extractField(fm, field): string | null`: the first line whose **trimmed** text starts with `field + ":"` (so indented lines match too, and `task` does not match `tasks:`). Value = text after the colon, trimmed. A quoted string followed by whitespace and a comment (`"x" # c`) keeps only the quoted part. A value wrapped in matching `"…"` or `'…'` loses the quotes (a `#` inside the quotes is kept: `"fix # in title"` stays). An unquoted value loses a trailing `\s+#.*` comment. `key:` with nothing after it gives `""`; no matching line gives `null`.
- `fmLineNo(fm, field, fmStart = 2, notFound = fmStart): number`: `fmStart + i` for the first line `i` whose trimmed text starts with `field + ":"`, else `notFound`. Pass `-1` as `notFound` to tell "absent" from "first line".
- `extractTagsList(fm): string[] | null`: find the first line whose trimmed text starts with `tags:`. If something follows the colon: strip a `\s+#…` comment; if the result starts with `[` or ends with `]` it is an inline list (strip one leading `[` and one trailing `]`, split on `,`, trim each item, strip one leading and one trailing quote character, drop empties; this holds even when one bracket is missing); otherwise the raw inline value is one tag. If nothing follows the colon, read a block list: following lines whose trimmed text starts with `- ` contribute `slice(2).trim()`; stop at a blank line or at a line containing `:`; other lines are skipped; no items gives `null`. `tags: []` gives `[]`. No `tags:` line gives `null`.
- `extractFmLists(fm): Map<string, string[]>`: for each **non-indented** line matching `/^([A-Za-z_][\w-]*):(.*)$/`: key = group 1; inline value = group 2 trimmed, with a comment after a closing bracket removed (`/(\])\s+#.*$/` replaced by `]`). If the inline value is non-empty: when it starts with `[` or ends with `]`, parse it like inline tags and store it if at least one item remains; a bracket-less inline value is a scalar and is **not** stored; go on to the next line. If the inline value is empty, collect a block list: scan the following lines, skip blank ones, stop at the first non-indented line, and for indented lines whose trimmed text starts with `- ` add `slice(2).trim()` (just that line's text; for `edges:` entries that is only `type: <value>`). Store if there is at least one item. Examples: `["tags: [a, b, c]"]` gives `tags → [a,b,c]`; `["commits:","  - abc123","  - def456","type: infra"]` gives `commits → [abc123, def456]` and no `type` key; a block with `tags: [infra, servers]`, `commits:` items, then `edges:` entries (`  - type: relates-to`, `    target: …`, `    context: "same rack"`) and `type: infra` gives `tags → [infra, servers]`, `commits → [aaa111, bbb222]`, `edges → ["type: relates-to"]`; `["files: [projects/a.md, b.md]  # just these"]` gives `files → ["projects/a.md","b.md"]`; empty input gives an empty map.

### Body checks

All three return `LineError[]`; line numbers are `startLineNo + index`.

- `FENCE_RE = /^ {0,3}(`{3,}|~{3,})/`; `INLINE_CODE_RE = /`[^`]*`/g`.
- `checkBodyPaths(body, startLineNo)`: walk the lines; a line matching `FENCE_RE` toggles an in-fence flag, and any line seen while the flag is on is skipped (the opening fence line is skipped, the closing one is not, which is harmless). On other lines remove inline code with `INLINE_CODE_RE`, then up to three independent errors per line:
  - contains `file://` → `body contains forbidden 'file://' URL`
  - matches `/(?:^|[\s"'(])\/(?:mnt|Users|home|root|var|etc|opt)\//` → `body contains an absolute Unix path (use a relative Markdown link instead)`
  - matches `/(?:^|[\s"'(])[A-Za-z]:[/\\]|\\\\[\w.-]+\\/` → `body contains an absolute Windows or UNC path (use a relative Markdown link instead)`

  `["see C:\\Users\\x\\file.md","and file:///tmp/x"]` from line 10 gives exactly two errors, the first at line 10. Paths inside fences or backticks give none.
- `checkRetiredWikiLinks(body, startLineNo)`: `blankCode(body.join("\n"))`, then one error per `WIKI_LINK_RE` match, at line `startLineNo + lineOf(matchIndex) - 1`, message exactly `wiki-link syntax is not supported; write [text](relative/path.md)`. `[[#Setup]]` counts; matches inside fenced or inline code do not.
- `bodyHeadings(body): {level, title, idx}[]`: headings outside fences, in order; `idx` is the 0-based body index. A line matching `FENCE_RE` toggles the fence flag and is never a heading. A heading matches `/^(#{1,6})\s+(.*?)\s*#*\s*$/` (level = number of `#`, title = group 2).
- `checkHeadings(body, startLineNo)`: every error is reported at `startLineNo`; in this order:
  1. number of level-1 headings ≠ 1 → `body needs exactly one H1 heading, found <n>`
  2. take the level-2 headings titled exactly `Summary`, `Notes` or `Related`, in document order; for each of the three names: count 0 → `body missing required section '## <name>'`; count > 1 → `section '## <name>' appears <n> times; keep one`
  3. if exactly three such headings were found and their order is not Summary, Notes, Related → `sections must be ## Summary, ## Notes, ## Related, in that order`

### Common shape check

`validateCommonNoteShape(path, preread?): {errors: LineError[], shape: NoteShape | null}`; `NoteShape = {fm, body, closeLineNo, fmStart: 2}`. The text comes from `preread` if given (even if `""`), else from the file. In order:
1. unreadable file → `[1, "cannot read file: <error>"]`, `shape = null`, stop.
2. text not ending in `\n` → `[0, "file does not end with a newline"]`; else if it ends in `\n\n` → `[0, "file has trailing blank lines (must end with exactly one newline)"]`.
3. after `splitLines`, empty or first line not `---` → `[1, "file does not start with '---' frontmatter delimiter"]`, `shape = null`, stop.
4. no closing `---` → `[1, "frontmatter opening '---' has no matching closing '---'"]`, `shape = null`, stop.
Otherwise `shape` is set; the step 2 errors may still be present.

### Typed edges

The optional top-level `edges:` frontmatter key holds a list of mappings with keys `type`, `target`, `context` (required) and `valid_at`, `invalid_at` (optional). It is the one field parsed as real YAML (`Bun.YAML.parse(fm.join("\n"))`). `Edge = {type, target, link, context, line, valid_at?, invalid_at?}`; `link` equals `target`; `line` is the file line of the entry's `- ` marker.

`extractEdges(fm, fmStart = 2): {edges: Edge[], errors: LineError[]}`:
- The block starts at the first line matching `/^edges:/` (column 0). No such line returns `{edges: [], errors: []}` without invoking the YAML parser. `blockLine = fmStart + index`.
- Entry lines: after the `edges:` line, every non-blank line belongs to the block until a column-0 line that does not start with `- ` (a column-0 `- ` still belongs to it). The entry line numbers are the file lines of block lines whose trimmed text starts with `- `, in order. Entry `i` uses `entryLines[i] ?? blockLine`.
- Structural errors at `blockLine`, returning no edges: YAML parse failure → `frontmatter declares 'edges:' but is not valid YAML: <first line of the parser message>`; value null/undefined → `'edges:' is present but empty — omit the key entirely when a note has no structural relationships`; not an array → `'edges:' must be a YAML list of entries, got <typeof value>`; empty array → `'edges:' is an empty list — omit the key entirely when a note has no structural relationships`.
- Per entry `i`, collect errors at the entry line, then drop the entry if any occurred:
  - not a plain object → `edges[i] must be a mapping with 'type', 'target' and 'context' keys` (nothing else checked for that entry)
  - for each of `type`, `target`, `context` (in that order) that is missing → `edges[i] is missing required key '<key>'`
  - `target` present but not a string → `edges[i] 'target' must be a string canonical id, e.g. target: projects/example, got: <typeof>`; a string target is trimmed and checked in this order, first hit wins:
    1. starts with `[[` → `edges[i].target uses the retired [[wiki-link]] syntax; write the canonical id (e.g. target: projects/example)`
    2. empty → `edges[i].target must be a non-empty canonical id`
    3. ends with `.md` or matches `/\.md[/#]/` → `edges[i].target must not include the '.md' extension; write the canonical id (e.g. target: projects/example), got: '<t>'`
    4. starts with `/` → `edges[i].target must be vault-relative, not an absolute path, got: '<t>'`
    5. contains `../` → `edges[i].target must not climb out of the vault with '../', got: '<t>'`
    6. contains `#` → `edges[i].target must not include a '#' heading anchor, got: '<t>'`
    7. contains `|` → `edges[i].target must not include a '|' alias, got: '<t>'`
  - `type` or `context` present but not a non-blank string → `edges[i] '<key>' must be a non-empty string`
  - `valid_at` / `invalid_at` if present: accept a string or a `Date` (YAML turns bare dates into `Date`; use its ISO date part); it must match `DATE_RE` and be a real date, else `edges[i] '<key>' must be a real calendar date as YYYY-MM-DD, got: '<value>'`; if both are valid and `invalid_at < valid_at` (string compare) → `edges[i] 'invalid_at' (<x>) precedes 'valid_at' (<y>)`
  - a clean entry becomes an `Edge` with trimmed `type`, `target`, `context`, `link = target`, `line`, plus the stamps that were present.
- `validateEdges(fm, fmStart, edgeTypes): LineError[]`: the errors of `extractEdges`, followed by, for each valid edge whose `type` is not in `edgeTypes`, `[edge.line, "edge 'type' must be one of <sorted set>, got: '<type>' — add it to 'edge_types' in vault.config.json before using it"]`.

## 8. validate-logs.ts

### `validateAgentLog(path, vaultRoot, edgeTypes = builtinEdgeTypes(), text?): [rel, LineError[]]`

`rel` = `toPosix(relative(vaultRoot, path))`. `text` (optional) is pre-read content passed through to `validateCommonNoteShape`. Errors are appended in this order:

1. Filename (basename) must match `/^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*\.md$/` → `[1, "filename does not match YYYY-MM-DD-slug.md pattern: <basename>"]`.
2. Shape errors from `validateCommonNoteShape`. If `shape` is null, return `[rel, errors]` now.
3. Required fields, in the order `updated, tags, type, agent, status, task, priority, date`: absent (`extractField === null`) → `[fmStart, "missing required frontmatter field: '<name>'"]`. A field present with an empty value counts as present; its value is judged below.
4. `type` present and not `agent-log` → at the `type` line: `'type' must be 'agent-log', got: '<v>'`.
5. `status` present and not one of `active, blocked, awaiting-approval, completed, error` → `'status' must be one of ['active', 'awaiting-approval', 'blocked', 'completed', 'error'], got: '<v>'` (sorted list format of section 3), at the `status` line.
6. `priority` present and not in `high, medium, low` → `'priority' must be one of ['high', 'low', 'medium'], got: '<v>'`.
7. For `date`, then `updated`: present and not matching `DATE_RE` → `'<f>' must match YYYY-MM-DD, got: '<v>'`; present, matching, but not a real date → `'<f>' is not a real calendar date: '<v>'` (at that field's line).
8. `extractTagsList` non-null and lacking the exact tag `agent-log` → at the `tags` line: `'tags' must contain 'agent-log'` (so `not-agent-log` fails; block-list tags are fine).
9. `agent` present and blank after trim → `'agent' value must be non-empty`.
10. `validateEdges(fm, fmStart, edgeTypes)` errors.
11. If `status` is `error`: `error_class` absent → `[fmStart, "status is 'error' but 'error_class' field is missing"]`; present and not `transient`/`permanent` → `'error_class' must be one of ['permanent', 'transient'], got: '<v>'`. And if there is no level-2 heading titled exactly `Error Log` (a level-3 one does not count) → `[closeLineNo + 1, "status is 'error' but body is missing '## Error Log' section"]`.
12. If `status` is `completed` **and no segment of `rel` is `archive`** (archived logs are frozen history): `completion_signal` not exactly `true` (absent, `false`, `yes`) → at its line, or `fmStart` if absent: `status is 'completed' but 'completion_signal' is not true`; `verified` absent → `[fmStart, "status is 'completed' but 'verified' field is missing (write verified: false; a human flips it)"]` (any value is accepted: a human sets `true`); `hasVerificationEvidence(body)` false → `[closeLineNo + 1, "status is 'completed' but '### Verification' under ## Notes is missing or empty (list the checks run and their results)"]`.
13. `checkHeadings(body, closeLineNo + 1)`, then `checkBodyPaths(...)`, then `checkRetiredWikiLinks(...)`.

### `hasVerificationEvidence(body): boolean`

Using `bodyHeadings`: track the current level-2 title (a level-1 heading resets it to none; a level-2 heading sets it). A level-3 heading titled `Verification` while the current level-2 title is `Notes` qualifies; its extent runs to the next heading of level 3 or less (or the end of body). True if any line in that extent is non-blank after trim and is not a placeholder matching `/^_\(.*\)_$/`. Fenced code lines count as content. Every qualifying heading is checked; one is enough. Placeholder-only, empty, or a Verification under another `##` section gives false.

### `findAgentLogs(vaultRoot): string[]`

Absolute paths of every file matching the glob `agents/**/reports/*.md` under `vaultRoot` (dot files not scanned), excluding any whose forward-slash form has an `archive` segment, sorted ascending. Normalise separators to `/` before the archive test.

### CLI

- `bun scripts/validate-logs.ts` validates every log from `findAgentLogs`; `bun scripts/validate-logs.ts a.md b.md` validates only those (resolved against cwd, sorted).
- For each target: a path that does not exist prints `<abs path>:1: file not found` and counts as one error but not as a validated file. Otherwise validate (with `EDGE_TYPES` from `loadFromScript`), count the file, and print each error as `<rel>:<line>: <message>`.
- No targets at all: print `No files found.`, exit 0. Zero errors: print `✓ <n> files validated, 0 errors`, exit 0. Otherwise print `✗ <n> files validated, <e> errors found`, exit 1.
- `--hook` (first argument) is Claude Code PostToolUse mode. Read stdin **synchronously** (`readFileSync(0, "utf8")`; an awaited async read can let the process exit first) and parse it as JSON (bad or empty input means nothing to check). `file = input.tool_input.file_path`. Exit 0 silently if there is no `file`, if `relative(vaultRoot, resolve(file))` (with `\` turned into `/`) does not match `/^agents\/[^/]+\/reports\/[^/]+\.md$/`, or if the file does not exist. Otherwise validate; with errors print `<rel>:<line>: <message>` lines to **stderr** and exit 2; else exit 0.

## 9. validate-vault.ts

### `validateVaultNote(path, vaultRoot, validTypes, edgeTypes = builtinEdgeTypes(), notesSplitLines = 150, text?): [rel, LineError[], LineError[]]`

Errors, then warnings; `rel` as before. Order of errors:

1. Shape errors; return early (with empty warnings) if `shape` is null.
2. `updated`: absent → `[fmStart, "missing required frontmatter field: 'updated'"]`; not `DATE_RE` → `'updated' must match YYYY-MM-DD, got: '<v>'`; not a real date → `'updated' is not a real calendar date: '<v>'` (at the `updated` line).
3. Tags (all at the `tags` line, or `fmStart` if absent): `extractTagsList` null → `missing required frontmatter field: 'tags'` and stop; for each tag: starts with `#` → `tag '<t>' must not have a '#' prefix`; differs from its lowercase → `tag '<t>' must be lowercase`. An empty list `[]` gives no error.
4. `type`: absent → `[fmStart, "missing required frontmatter field: 'type'"]`; not in `validTypes` → `'type' must be one of <sorted set>, got: '<v>'` (for the template config: `['agent-log', 'concept', 'decision', 'glossary', 'handoff', 'infra', 'personal', 'project', 'reference', 'skill']`). The order of fields in the file is not checked.
5. `validateEdges(fm, fmStart, edgeTypes)`.
6. `checkHeadings`, `checkBodyPaths`, `checkRetiredWikiLinks`, each with start line `closeLineNo + 1`.
7. Warning only (never an error): skipped when `type` is `decision` or `personal`, or when `isRestricted(rel)` (path rule). The `## Notes` section length is the number of lines after the line whose trim equals `## Notes` up to (excluding) the next line matching `/^##\s+\S/` (so `###` does not end it) or the end of body, blank lines included. No `## Notes` line means no warning. If the length is greater than `notesSplitLines` → `[closeLineNo + 1, "notes section is <n> lines (><threshold>): split into a parent plus part-of children"]`.

### Scopes

- `ROOT_SKIP_FILES = {CLAUDE.md, AGENTS.md, README.md, _format.md}`.
- `shouldSkip(rel)` (schema scope, forward-slash `rel`): true for a root-level file in `ROOT_SKIP_FILES`; if any segment is in `NONCONTENT_SUBTREES`; if `rel` matches `/^agents\/[^/]+\/reports\//` (logs belong to validate-logs; the rest of `agents/` and `handoffs/` are ordinary notes); if the basename is `index.md` or `graph.md` (generated, no frontmatter).
- `skipForEdges(rel)` (link scope, wider): true if any segment is in `NONCONTENT_SUBTREES` or the basename is `index.md` or `graph.md`. Agent reports and root files like `AGENTS.md` are link-checked even though they are not schema-checked.

### Link resolution

`buildResolver(vaultRoot): LinkResolver`: one walk with `new Bun.Glob("**/*").scanSync({cwd: vaultRoot, dot: true})` (files only; dot-directories included). Each result goes through `toPosix`. Skip any path with a `.git` segment. `*.md` files go to `noteFiles` (sorted); every other file path goes to an attachment set (exact path, case preserved). `directories` = every ancestor directory path of every kept file (so an empty folder is not a directory). `allNotes` = sorted `canonicalId` of `noteFiles`.

| Member | Behaviour |
|---|---|
| `resolve(href, fromRel)` | `resolveHref(fromRel, href)`; if non-null and in the note set → its `canonicalId`, else `null`. Exact, case-sensitive, `.md` required, no stem or basename fallback. Attachments return `null` |
| `exists(href, fromRel)` | `resolveHref`; true if the result is a note, an attachment, or a directory (strip one trailing `/`; non-empty; in `directories`). So `[x](sub/)` and `[x](../scripts)` resolve when the directory contains files; `[LICENSE](../LICENSE)` resolves as an attachment |
| `resolveId(id)` | `id` if a note with that canonical id exists, else `null` (edge targets are ids, not hrefs) |
| `ambiguousStems` | always an empty `Map` (retired, kept for compatibility) |
| `allNotes`, `noteFiles` | as above |

`readNote(vaultRoot, rel): string | null`: the file text, `null` on any read error.

`isGitIgnoredLinkTarget(vaultRoot, sourceRel, target): boolean`:
- `t = target.trim().split("|")[0].split("#")[0].trim()`; empty gives `false`.
- Two call shapes. Edge target: a bare canonical id, `sourceRel` is the linking note's own path (non-empty); if `t` has no extension (`/\.[A-Za-z0-9]+$/`) append `.md`. Body link: the already-resolved vault-relative path with `sourceRel = ""`; use `t` exactly as given (a trailing `/` or an extensionless attachment name must not get `.md`).
- Candidates (a set): the path itself and, when `sourceRel` has a directory part, `<that directory>/<path>`.
- Run `git check-ignore --no-index --stdin` in `vaultRoot` with the candidates newline-separated on stdin (stdout and stderr piped). Return `exitCode === 0` (at least one is ignored). Outside a git repo git fails, so the result is `false` and the link stays broken.
- Examples with `/SYSTEM.md` and `personal/**` ignored: `("", "SYSTEM.md")` true; `("", "personal/jobs/Resume.pdf")` true; `("", "ghost.md")` false; `("projects/alpha.md", "SYSTEM")` true; with the rule `personal/private/`, `("", "personal/private/")` true.

`isUncheckedSubmoduleTarget(vaultRoot, target)`: `t` = the same cleaning as above, lowercased. If `<vaultRoot>/.gitmodules` does not exist → `false`. For each `path = <value>` line (`/^\s*path\s*=\s*(.+?)\s*$/gm`, backslashes turned into `/`): if `t` starts with `<path lowercased>/`, return true when the submodule directory does not exist or contains no `*.md` file (not checked out); otherwise false. No matching submodule → `false`.

### `checkLinks(vaultRoot, resolver = buildResolver(vaultRoot), read = (rel) => readNote(vaultRoot, rel)): LinkReport`

`LinkReport = {broken: [rel, line, msg][], links: LinkRecord[]}`; `LinkRecord = {path, line, kind: "markdown" | "edge", target, resolved: boolean, inRelated: boolean, msg?}`.

For each `rel` in `resolver.noteFiles` with `!skipForEdges(rel)` (a note whose `read` returns `null` is skipped):
1. Parse with `parseFrontmatter(splitLines(text))`. The body is its body (start line `closeLineNo + 1`) or, with no frontmatter, all lines (start line 1). Arbitrary frontmatter fields are never scanned for links.
2. **Edge targets** (only the `edges:` key, via `extractEdges(parsed.fm).edges`): `target = resolver.resolveId(edge.link)`; exempt if it resolved, or `isGitIgnoredLinkTarget(vaultRoot, rel, edge.link)`, or `isUncheckedSubmoduleTarget(vaultRoot, edge.link)`. Not exempt → broken `[rel, edge.line, "broken edge target <edge.target> — no matching note"]`. Record `{path: rel, line: edge.line, kind: "edge", target: edge.link, resolved: exempt, inRelated: false, msg?}`.
3. **Body links**: `vaultLinks(body.join("\n"))`. File line = `startLine + link.line - 1`. `inRelated`: over the code-blanked body, track the current level-2 heading (`/^##\s+(.+?)\s*$/`; "in Related" when its trimmed title is `Related`); a link is in Related if the state at its line (including the heading line itself) is Related.
   - `link.path` starts with `/` → `broken link [<text>](<href>) — absolute paths are not allowed`.
   - else `resolved = resolveHref(rel, link.href)`; `null` → `broken link [<text>](<href>) — escapes the vault`.
   - else if `!resolver.exists(href, rel)`: unless `isGitIgnoredLinkTarget(vaultRoot, "", resolved)` or `isUncheckedSubmoduleTarget(vaultRoot, resolved)` → `broken link [<text>](<href>) — no file at <resolved>`. `<text>` and `<href>` are the unescaped text and decoded href exactly as `extractLinks` returns them; `<resolved>` keeps a trailing `/` for a directory link.
   - Record `{path, line, kind: "markdown", target: href, resolved: (no message), inRelated, msg?}`.

Return `{broken, links}` in scan order (sorted notes; edges before body links within a note).

### CLI

- Flags: `--json`, `--links`; the remaining arguments are file paths.
- `--links`: `checkLinks(vaultRoot).broken` only. Text mode prints `<path>:<line>: <msg>` lines, then `✓ links ok` (exit 0) or `✗ <n> broken link(s)` (exit 1). With `--json` it prints `{ok, errorCount, errors: [{path,line,msg}]}` (2-space indent) and exits 0 or 1.
- Otherwise: with no file arguments, a **full scan**: one resolver, one text read per note shared with the link check, targets = `noteFiles`. With file arguments, only those files (resolved against cwd, sorted), `shouldSkip` is not applied (explicitly named files are always checked), and the link check is not run. For each target: not existing → error `{path: relative(vaultRoot, path), line: 1, msg: "file not found"}`; in a full scan files matching `shouldSkip` are skipped; every checked file counts. A file whose frontmatter `type` is `agent-log` goes to `validateAgentLog` (no warnings); everything else to `validateVaultNote`. In a full scan the broken links from `checkLinks` (same resolver and cached reads) are appended to the errors.
- Text output: errors as `<path>:<line>: <msg>`, then warnings as `<path>:<line>: warning: <msg>`, then `✓ <n> files validated, 0 errors` (with `, <w> warning(s)` appended when there are warnings; exit 0) or `✗ <n> files validated, <e> errors found` (exit 1). `--json`: `{ok, count, errorCount, errors, warningCount, warnings}`, 2-space indent, items `{path,line,msg}`.
- A template with no non-skipped notes prints `✓ 0 files validated, 0 errors`.

## 10. capture.ts

- `ymd(d)` is local `YYYY-MM-DD`; `ym(d)` is local `YYYY-MM` (zero-padded).
- `resolvePath(d, vaultRoot, noteType, noteName, today): string`: if `noteType` is in `d.EPISODIC_DIRS` → `join(vaultRoot, dir, "<ym(today)>.md")` (the name is ignored). Else if it is in `d.SEMANTIC_DIRS`: `noteName` empty, containing `/` or `\`, or equal to `.` or `..` → throw `invalid --note '<name>': must be a plain filename with no path separators`; else `join(vaultRoot, dir, "<noteName>.md")`. Else throw `unsupported type '<type>' (choices: <TYPE_DIRS keys joined by ", ">)`. Universal types such as `concept` are therefore unsupported.
- `createNote(d, path, noteType, noteName, today)`: creates parent folders and writes exactly (LF, single trailing newline):

  ```
  ---
  updated: <ymd>
  tags: [<noteType>]
  type: <noteType>
  ---

  # <title>

  ## Summary
  _(none yet)_

  ## Notes

  ## Related
  _(none yet)_
  ```
  `title`: episodic type → `<TitleCase(type)> <ym>` (e.g. `Decision 2026-09`); semantic → `TitleCase(noteName)`, where TitleCase replaces `-` and `_` with spaces and upper-cases the first letter of each word (`new-node` → `New Node`). The result passes the validator.
- `insertBullet(path, fact, today, vaultRoot, validTypes, edgeTypes?)`:
  1. Read the original bytes; `splitLines` the text (a BOM is dropped and CRLF becomes LF in the rewrite). No frontmatter → throw `<path>: frontmatter missing or malformed`.
  2. Bump `updated`: if the frontmatter has an `updated:` line (`fmLineNo` with notFound `-1`), replace that whole line with `updated: <today>`; otherwise insert `updated: <today>` as a new line directly after the opening `---`.
  3. Insert `- <today>: <fact>` inside `## Notes`: find the line exactly equal to `## Notes`; scanning forward, the insertion index is just after the last line starting with `- ` before the next line starting with `## `; with no bullet, directly after the heading line; with no `## Notes` heading, append at the end. The blank line before the next heading is kept (`...- 2026-01-01: first\n- 2026-09-07: shipped v2\n\n## Related`).
  4. Write `lines.join("\n") + "\n"`.
  5. Validate in-process with `validateVaultNote(path, vaultRoot, validTypes, edgeTypes)` (warnings ignored). On any error write the **original bytes** back and throw `validator rejected the modified note — restored original.` followed by a newline and one line per error, `  :<line>: <message>`, joined with newlines. (Example trigger: a fact containing `C:\Users\x\y.md`.)
- CLI `bun scripts/capture.ts --type <type> [--note <name>] "<fact>"`, `-h/--help`. Exactly one positional (the fact) and `--type` are required, otherwise `consola.error(<message>)`, the usage text on stderr, exit 2. The two argument errors are `need --type and exactly one <fact>` (missing `--type`, or any number of positionals other than one), printed as `consola.error` (stderr) followed by the usage block on stderr, exit 2. The usage block, exactly:
  ```
  Usage: bun scripts/capture.ts --type <type> [--note <name>] "<fact>"

  Append a dated fact to a vault note and bump its updated: date.
    --type <type>   semantic (project|infra|...) or episodic (decision|...)
    --note <name>   note name; required for semantic types, ignored for episodic ones

  Examples:
    bun scripts/capture.ts --type project --note vkit "v0.3.1 adds folder routing"
    bun scripts/capture.ts --type decision "decided to defer Phase 4"
  ```
  `--help` prints it to stdout, exit 0. A fact containing a newline → error `fact must be a single line (no newlines)`, exit 2. A semantic type without `--note` → error `--note <name> required for semantic type '<type>'`, exit 2. `resolvePath` errors → `consola.error`, exit 2. If the target file does not exist: `consola.info("note not found — creating: <vault-relative path>")` and `createNote`. Then `insertBullet` (any error: `consola.error(message)`, exit 1; a freshly created skeleton stays). Success: `consola.success("captured → <vault-relative path>")`, exit 0.

## 11. move-note.ts

Moves a note and keeps every link to and from it valid. Three kinds of rewrite happen and nothing else; everything else stays byte-identical, line endings included.

- `splitRaw(text)` (private) splits into lines keeping each terminator (`\n` or `\r\n`, none on a final unterminated line) and finds the closing `---` index (none without frontmatter). Link rewriting is applied to the **body only** (everything after the closing `---`, or the whole text if there is no frontmatter), never to frontmatter. File listing skips only paths with a `.git` or `node_modules` segment (narrower than `NONCONTENT_SUBTREES`: links living in `scripts/`, `dashboard/` or `.claude/` must be fixed too).
- `spliceLinks(bodyText, ownerRel, remap)`: for each `vaultLinks(bodyText)` link, `remap(href)` returns a new vault-relative target path or `null`; for non-null, replace the link's `raw` span (at `link.index`) with `mdLink(link.text, ownerRel, target, link.anchor)` and count it; null leaves the original bytes. Links in code, images, external links and bare anchors are not considered. The count is the number of links rewritten, whether or not the new text differs.
- Outbound rewrite (the moved file): `remap = href => resolveHref(fromRel, href)`, `ownerRel = toRel`. Every link that resolves inside the vault is rebuilt relative to the new location, anchors kept; a link that does not resolve (escapes the vault) is untouched.
- Inbound rewrite (another file `rel`): `remap = href => resolveHref(rel, href) === fromRel ? toRel : null`, `ownerRel = rel`.
- Edge-target rewrite (applied to the result of the inbound rewrite): within the frontmatter `edges:` block (first `/^edges:/` line; the block continues over indented lines, lines starting with `- ` and **blank lines** (a blank line never ends it), and ends at the first non-blank column-0 line that is not `- `), a line matching `/^(\s*)target:\s*(.*)$/` whose value, trimmed and with one leading and one trailing quote character removed, equals `fromId` becomes `<indent>target: <toId>` with its original newline (unquoted). Other lines, including `context:`, are untouched. The `- target: x` first-key form is not matched.

```ts
interface InboundEdit { rel: string; text: string; linksChanged: number; edgesChanged: number }
interface MovePlan {
  from: string; to: string;              // vault-relative, posix, ".md" included
  fromId: string; toId: string;          // canonicalId(from), canonicalId(to)
  outbound: { text: string; changed: boolean; linksChanged: number } | null; // null when `from` is missing on disk
  inbound: InboundEdit[];                // sorted by rel; only files that needed a change
}
```

- `planMove(vaultRoot, fromRel, toRel): MovePlan` writes nothing. `outbound` is computed from the existing source file (`changed = newText !== original`). `inbound`: for every `**/*.md` file (dot-directories included, `.git` and `node_modules` segments skipped, unreadable files skipped) except `fromRel`, apply the inbound link rewrite, then the edge rewrite; include `{rel, text, linksChanged, edgesChanged}` only if either count is non-zero; sort by `rel` with plain `<` comparison.
- `applyMove(vaultRoot, plan, opts: {git?: boolean} = {})`: if `plan.outbound` is null throw `move-note: source file does not exist: <from>`. Then, in order: write each inbound edit (skip any with both counts zero); create the destination's parent folders; if `outbound.changed`, write the rewritten text to the **old** path; then move. Use `git mv <from> <to>` (relative paths, cwd = vault root) when `(opts.git ?? true)` and the vault is inside a git work tree (`git rev-parse --is-inside-work-tree` exits 0); on failure throw `move-note: git mv failed: <stderr, trimmed>`. Otherwise `renameSync`. A committed file with no outbound change then shows in `git status --porcelain` as `R  <from> -> <to>`.
- CLI `bun scripts/move-note.ts <from> <to> [--dry-run]`, `-h/--help`: exactly two positionals, else a usage error and exit 2 (`Usage: bun scripts/move-note.ts <from> <to> [--dry-run]   (vault-relative paths, .md included)`; `--help` prints it to stdout, exit 0). Both arguments go through `toPosix`. It prints the plan, then either `dry run — nothing written. Re-run without --dry-run to apply.` (`consola.info`) or applies with `{git: true}` and prints `moved -> <to>` (`consola.success`). Plan output lines:
  ```
  move: <from> -> <to>
    outbound links rewritten: <n>
    inbound files changed:    <n>
      <rel>  (links: <n>, edges: <n>)        (one per inbound file, indented 4 spaces)
  ```

## 12. consolidate.ts

- `ARCHIVE_THRESHOLD_DAYS = 90`.
- `dateOrNull(val)`: `null` unless `val` is `YYYY-MM-DD` and a real date; else that date at UTC midnight.
- `todayCalendarDate(now)`: the UTC-midnight `Date` of `now`'s local year, month and day.
- `resolveRelatedLink(vaultRoot, fromPath, href)`: `resolveHref(<fromPath relative to vaultRoot, posix>, href)`; null if unresolvable; else the absolute path (`join(vaultRoot, resolved)`) if that file or folder exists, else null.
- `relatedLinkHrefs(body)`: collect the lines after the first line starting with `## Related`, up to the next line starting with `## `; return the `path` (anchor stripped) of every `vaultLinks` link in those lines, in order.
- `findArchivalCandidates(d, vaultRoot, today): [absPath, agentName][]`: `threshold = todayCalendarDate(today) - 90 days`. For each log from `findAgentLogs` (sorted order): frontmatter readable, `status === "completed"`, a valid `date`, and `date < threshold` (strictly: a log exactly 90 days old is not a candidate). `agentName` = the path segment after `agents`. Archived logs are never listed (they are not in `findAgentLogs`). Only age and status matter, not `verified`.
- `findDistillationCandidates(d, vaultRoot): [logAbs, noteAbs][]`: for each log in `findAgentLogs` with `status === "completed"` and a valid `date`: for each Related href: resolve with `resolveRelatedLink`; skip if unresolved; skip unless `basename(dirname(resolved))` equals one of the **values** of `d.SEMANTIC_DIRS` (only notes directly in a semantic folder count; episodic folders such as `decisions/` do not); skip if this `log|note` pair was already seen (a note linked by several bullets counts once); read the linked note's frontmatter and skip if `updated` is missing or invalid; if `updated < log date`, add `[logAbs, noteAbs]`.
- `archiveLogs(candidates, vaultRoot, apply): boolean` (true means no failure). No candidates → `consola.info("archive: 0 candidates (nothing to do)")`, return true. Otherwise `consola.info("archive: <n> candidate(s)")` plus `  [DRY RUN — use --apply to execute]` when not applying. For each `[path, agent]` in order: `dest = agents/<agent>/reports/archive/<basename>`; build `planMove` for (relative posix source, relative posix destination) **fresh per candidate**; if `apply`, `applyMove(vaultRoot, plan, {git: true})` and `consola.success("archived → <dest>  (rewrote <inbound count> other file(s), <outbound linksChanged or 0> outbound link(s))")`; on an exception `consola.error("archiving <basename>: <message>")`, mark failure and carry on; if not applying, `consola.log("  would archive → <dest>  (would rewrite <n> other file(s), <m> outbound link(s))")`. After applying, relative links inside the moved log gain one `../`, inbound links elsewhere point at `archive/`, and `checkLinks` reports nothing broken.
- CLI `bun scripts/consolidate.ts [--apply] [--archive-only] [-h]`: usage error exit 2; `--help` prints usage (`Usage: bun scripts/consolidate.ts [--apply] [--archive-only]` plus a line saying it is a dry run by default and `--apply` moves completed logs older than 90 days into archive/) and exits 0. It runs `archiveLogs(findArchivalCandidates(...), vaultRoot, apply)` with `today = new Date()`. Unless `--archive-only`: print an empty line, then the distillation report. None → `consola.info("distillation: 0 stale links found — semantic notes appear up to date")`; else `consola.info("distillation: <n> log(s) may have facts not yet in semantic notes")`, a dim line `  → use capture.ts to fold each fact in, then re-run to confirm resolution` followed by a blank line, then per pair `  [ ] <log relative path>` and `        → update: <note relative path>`. Exit 1 if any archive failed, else 0.

## 13. index.ts

Generates `index.md` per configured folder. Generated files have **no frontmatter** (validators skip any `index.md`) and begin with the header `<!-- generated by scripts/index.ts — regenerate, don't hand-edit -->`. Output is deterministic (no timestamps).

- `NoteMeta = {file, title, description, tags, type, updated}`.
- `loadNoteMeta(path): NoteMeta`: `file` = basename; fallback title = file name without `.md`. Never throws: an unreadable file gives the fallback title and blank fields. No frontmatter → title from the first `# ` heading of the whole file (`/^#\s+(.+)$/` on a trimmed line; `##` does not match) else the fallback, other fields blank. With frontmatter: title from the first H1 in the body else the fallback; `description` = `extractField("description") ?? ""`; `tags` = `extractTagsList ?? []`; `type`, `updated` = the field or `""`.
- `notesInDir(dir): NoteMeta[]`: files directly in `dir` ending `.md`, not named `index.md`, **excluding restricted notes** (`isRestricted(<path relative to the script's own vault root, posix>, <file text>)`, so the frontmatter flag works for any directory); sorted by file name; mapped through `loadNoteMeta`.
- `noteSubfolders(dir): string[]`: names of immediate subdirectories, excluding `.venv`, `__pycache__`, and any directory containing a `package.json` or a `node_modules`; sorted.
- `noteLine(n, pathPrefix = "")` (private): `- ` + `mdLink(n.title, "index.md", pathPrefix + n.file)` (title escaped; an href with spaces is `<…>`-wrapped); if `description`: ` — <description>`; if any meta: ` (` + parts joined by ` · ` + `)` where the parts are, in order and only when non-empty, `type: <type>`, `tags: <tags joined by ", ">`, `updated: <updated>`.
- `buildIndex(dirName, notes, style: "default" | "alphabetical", subfolders: SubfolderNotes[] = []): string`, `SubfolderNotes = {name, notes}`. `header = "<generated header>\n\n# <dirName>\n"`. Each subfolder section is `"\n## <name>/\n\n"` + its lines (prefix `<name>/`) joined by `\n` + `"\n"`.
  - no notes and no subfolders → `header + "\n_(no notes yet)_\n"`.
  - no notes, some subfolders → `header` + the subfolder sections.
  - `alphabetical`: `header + "\n"` + lines of the notes sorted by `title.localeCompare`, joined by `\n`, + `"\n"` + subfolder sections.
  - `default`: group by `type` (blank type goes in `untyped`); groups ordered by default string sort of the group name; within a group sort by `updated` descending (`localeCompare`; blank sorts last) then `title.localeCompare`; each group renders `"\n## <type>\n\n"` + lines joined by `\n` + `"\n"`; result = `header` + groups + subfolder sections.
- CLI `bun scripts/index.ts [dir ...]`: configured folders = values of `semantic_dirs`, `episodic_dirs` and `extra_dirs`. Without arguments: every configured folder that exists and has at least one direct note, in sorted order. With arguments: each is resolved with `resolveInside` against the vault root (escape → `error: <message>` on stderr, exit 2) and converted to a posix path relative to the vault; arguments that are not configured folders are silently ignored; named folders are regenerated even if they hold no notes (they get the "no notes yet" index; a folder that does not exist is skipped). Style = `alphabetical` when `index_style[<dir>] === "alphabetical"`, else `default`. For each folder: for each `noteSubfolders` entry with at least one note, write that subfolder's own `index.md` (`buildIndex(name, notes, "default")`, bare links) and print `✓ index.md → <dir>/<sub>/`; then write the folder's `index.md` (`buildIndex(dir, notes, style, subfolders)`) and print `✓ index.md → <dir>/`. If nothing was written, print `no target directories with notes found`. Exit 0.

## 14. search.ts

Keyword search over notes: BM25, in memory, rebuilt on every call.

- `tokenize(text)`: lowercase, split on runs of anything that is not `a-z` or `0-9`, drop empty strings. No stemming, no stop words.
- Types: `Doc = {path, length, termFreq: Map<string, number>}`, `CorpusStats = {N, avgdl, df: Map<string, number>}`, `ScoreFn = (queryTokens, doc, corpus) => number`, `NoteInput = {path, text}`, `Result = {path, line, snippet, score}`.
- `bm25(queryTokens, doc, corpus)`: `k1 = 1.2`, `b = 0.75`; `avgdl = corpus.avgdl || 1`; for each **distinct** query token with term frequency `tf > 0` in the document: `idf = ln(1 + (N - df + 0.5) / (df + 0.5))`, `score += idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * length / avgdl))`.
- Indexing a note: split into lines; the body is everything after the closing frontmatter `---` (or the whole file if there is none); frontmatter is excluded from the corpus. Document length = total tokens of the body; `termFreq` counts over the body. Each body line keeps its real **file** line number (`closeLineNo + 1 + i`, or `1 + i` without frontmatter). Corpus stats: `N` = number of notes, `avgdl` = total length / N (0 if no notes), `df` = number of notes containing the term.
- `search(notes, query, scoreFn = bm25): Result[]`: no query tokens → `[]`. Score every note and drop scores `<= 0`. For each kept note pick the **best line**: the first body line covering the most distinct query terms (strictly-greater comparison, so ties keep the earliest line; no matching line drops the note). Result `{path, line: file line, snippet: that line trimmed, score}`. Sort by score descending (stable, so ties keep input order).
- `loadNotesFromVault(vaultRoot): NoteInput[]`: every `**/*.md` found by `Bun.Glob` (dot-directories are not scanned), absolute-path sorted; `rel` = posix path relative to the vault. Skip when any segment of `rel` is in `NONCONTENT_SUBTREES ∪ {agents, handoffs}`, when `rel` is `index.md` or ends in `/index.md`, when the file vanished, or when `isRestricted(rel, text)` (the `personal/` path rule, or `restricted: true` in frontmatter: the privacy boundary). Entries are `{path: rel, text}`.
- CLI `bun scripts/search.ts <terms...> [--limit N] [--json]`, `-h/--help`: terms joined by spaces are the query. No terms → usage on stderr, exit 1; argument errors exit 1; `--help` prints usage to stdout, exit 0. Usage line: `Usage: bun scripts/search.ts <query terms...> [--limit N] [--json]`. Limit: `Number(--limit)` if finite and `> 0`, else 10; results are sliced to it. Text output: one line per result `<path>:<line>: <snippet>  (<score, 3 decimals>)` (two spaces before the parenthesis); no results prints nothing. `--json`: `JSON.stringify(results, null, 2)`.

## 15. dashboard.ts

- `ARTIFACT = "dashboard/agent-status.md"`; generated header `<!-- generated by scripts/dashboard.ts — regenerate, don't hand-edit -->`.
- `TaskLog = {path, agent, status, priority, date, task, verified: boolean}`. `collectLogs(vaultRoot)`: every log from `findAgentLogs` with readable frontmatter; each field is `extractField(...) ?? ""`; `verified` is true when the field equals `true`; `path` is posix and vault-relative. Sorted by priority (`high` 0, `medium` 1, `low` 2, anything else 9), then `date` descending (string compare), then `path` ascending (`localeCompare`). Archived logs are not included.
- Groups, in this order: `Needs you (awaiting approval or blocked)` (status `awaiting-approval` or `blocked`), `Errors` (`error`), `Active` (`active`), `Completed, unverified` (`completed` and not verified), `Completed, verified` (`completed` and verified).
- `renderMarkdown(all): string`: lines joined by `\n` plus a trailing `\n`:
  1. the header comment, an empty line, `# Agent Status`, an empty line, and `<n> live agent log(s). Regenerate with `` `bun run dashboard --write` ``.` (the backticks are literal).
  2. For each group: an empty line, `## <title> (<count>)`, an empty line; then `_(none)_` when the group is empty, else the table header `| Date | Priority | Agent | Task |`, the separator `|---|---|---|---|` and one row per log: `| <date> | <priority> | <agent> | <link> |`. The `agent` cell has `|` escaped as `\|`, whitespace runs collapsed to one space, and is trimmed. `link` = `mdLink(<task with whitespace collapsed and trimmed, or the path if that is empty>, ARTIFACT, <log path>, null, true)`: it points at `../agents/<agent>/reports/<file>` and a `|` in the task text appears with a backslash before it (for example `[Alpha \| pipe](../agents/tester/reports/2026-10-01-a.md)`).
  The output starts with the HTML comment, never with `---`. With no logs all five group headings still appear, each ending `(0)` and followed by `_(none)_`.
- `render(all): string` (terminal): for each non-empty group, a bold line `<title> (<count>)`, then one row per log `  <dim date>  <priority padded to 6>  <task>  <cyan path>`, then an empty line; lines joined by `\n`. With no logs, the string `No live agent logs.\n`.
- CLI `bun scripts/dashboard.ts [--write]`: prints `render(logs).trimEnd()`; with `--write` it also creates `dashboard/` if needed, writes `renderMarkdown(logs)` to `dashboard/agent-status.md` and prints `wrote dashboard/agent-status.md`. Exit 0.

## 16. commit-task.ts

- `porcelainPaths(porcelain): string[]`: for every non-blank line of `git status --porcelain` output take `line.slice(3)` (status code plus one space); for a rename (`old -> new`) keep the part after ` -> `; remove one leading and one trailing `"`.
- `addCommitSha(fm: string[], sha: string): string[]` (pure, on frontmatter lines; returns a new array):
  - If a line matching `/^commits:/` exists: remove a `\s+#…` comment from that line, read the existing list with `extractFmLists` (strip surrounding quotes from each item), extend `end` over any following block items matching `/^\s+-\s/`, and replace lines `idx..end` with one inline list `commits: ["a1", "b2"]` (each SHA double-quoted, separated by `, `, the new SHA last). `['commits: ["a1"]     # SHAs','model: x']` with `b2` gives `['commits: ["a1", "b2"]','model: x']`; `["commits:","  - a1","  - c3","model: x"]` with `b2` gives `['commits: ["a1", "c3", "b2"]','model: x']`.
  - Otherwise insert `commits: ["<sha>"]` directly after the first existing line (column 0) found by trying these keys **in this priority order**: `cost_usd, tokens_out, tokens_in, retry_count, error_class, completion_signal, verified, date`; if none exists, append at the end. `["date: 2026-10-01"]` gives `["date: 2026-10-01", 'commits: ["b2"]']`. For the example log this inserts after `completion_signal: true`.
- CLI `bun scripts/commit-task.ts <log> [-m "<message>"] [--dry-run] [--no-record]`, `-h/--help` (`-m` is `--message`). Exactly one positional, else usage error, exit 2; `--help` prints usage to stdout, exit 0. The errors below are thrown and surface as `error: <message>` through `runMain` (exit 1). It never uses `--no-verify` or `--amend`; the repository's pre-commit hook runs on both commits.
  1. The log path is resolved against cwd; missing → `log not found: <arg>`.
  2. Validate with `validateAgentLog`; on errors print each `<rel>:<line>: <message>` via `consola.error` and throw `log fails validation — fix before committing (<n> error(s))`.
  3. Parse the frontmatter; `status` must be `completed` or `error`, else throw `<rel>: status is '<status>', must be 'completed' or 'error' to commit`. Read `agent` (default `agent`), `task` (default empty) and the optional `session` field (not part of the schema; when present it becomes a trailer).
  4. Files to stage: if `files:` is a list in the frontmatter (`extractFmLists(fm).get("files")`): `[relLog, ...listed minus relLog]`; otherwise `porcelainPaths(git status --porcelain -uall)` (git already omits ignored files). `relLog` is the log's vault-relative posix path. Print `consola.info("staging <n> file(s):")` and each path indented two spaces.
  5. Message: the `-m` value split at the first newline into subject and rest; `subject` = that first line, or `<agent>: <task>` if empty, truncated to 72 characters (when longer: the first 71 characters right-trimmed plus `…`); `extra` = the remaining lines, trimmed. `fileList` = `\nFiles:\n- <f>\n- <f>...\n` (one line per file) if there are files, else `\n`. `body` = (`\n<extra>\n` if `extra`) + `fileList`. `trailer` = `\nClaude-Session: <session>\n` if `session` is set, else `\n`. Message = `<subject>\n<body><trailer>` with every run of three or more newlines collapsed to two.
  0. Usage text (stdout for `--help`; stderr after a usage error, whose first line is `consola.error(need exactly one <log>)` for a wrong positional count), exactly:
     ```
     Usage: bun scripts/commit-task.ts <log> [-m "<message>"] [--dry-run] [--no-record]
       -m, --message  commit message (first line is the subject; the rest becomes the body)
       --dry-run      print the commit that would be made, without writing anything
       --no-record    skip the second commit that records the SHA back into the log
     ```
  6. `--dry-run` (the message is printed with `consola.log` and is not trimmed, so a message that already ends in a blank line gets one more newline from the print: typically two blank lines before the closing marker): print `dry run: would commit with message`, then the message between a dim `--- commit message ---` line and a dim `--- end (no commit made) ---` line; write nothing; return (exit 0). Otherwise zero files → throw `nothing to stage — git status --porcelain is empty`.
  7. Stage: with a `files:` list `git add -A -- <files...>` (also stages deletions), else `git add -A`. Commit the **index** with `git commit -m <message>` (never a pathspec: a partial commit would drop the `index.md` files the pre-commit hook stages). Print `committed <sha>` (`consola.success`; sha from `git rev-parse HEAD`). Any git failure throws `git <args> failed: <stderr or stdout>`.
  8. `--no-record` stops here. Otherwise rewrite the log with `addCommitSha(fm, sha)`: `["---", ...newFm, "---", ...body].join("\n") + "\n"`; validate again (errors: print them and throw `updating 'commits:' broke validation — log left modified for manual fix, no second commit made`); then `git add -- <relLog>`, `git commit -m "<agent>: record task commit"`, and print `recorded SHA in log, committed <sha2>`.

## 17. stale-logs.ts

`bun scripts/stale-logs.ts [--apply]`. Constants: abandon threshold 30 days, warning threshold 3 days. Age in whole days = floor((local calendar date of today as UTC midnight minus the log's `date` as UTC midnight) / 86 400 000); a log without a valid `date` has no age and is never listed in the abandon or warning groups.

- Groups (from `findAgentLogs`, logs with parseable frontmatter): **abandon candidates** = status `active` or `blocked` with age `> 30`; **awaiting-approval** = every log with that status (never auto-expires, listed regardless of age); **warnings** = status `active` with `3 < age <= 30`.
- Output, always:
  ```
  abandon candidates (status active|blocked, date >30d old)[  [DRY RUN]]: <n>
    <rel>  status=<status> date=<date> age=<n>d

  awaiting-approval (never auto-expire; listed for human): <n>
    <rel>  date=<date or ?> age=<n or ?>d

  active >3d warning only (not abandoned): <n>
    <rel>  date=<date> age=<n>d
  ```
  (`  [DRY RUN]` appears only without `--apply`; the blank lines precede the second and third heading.) Without `--apply`, stop (exit 0).
- `--apply`: print an empty line and `applying <n> abandon edit(s)...`; for each candidate perform the edit below, then re-validate with `validateAgentLog`. Success prints `  ✓ <rel> -> status: error (permanent)`; errors print `  ✗ <rel>: <n> validation error(s) after edit` and each `      <rel>:<line>: <message>`. Exit 1 if any failed, else 0.
- The edit on one log:
  - Frontmatter: every line whose trimmed text starts with `status:` becomes `status: error`. If no `error_class:` line exists, insert `error_class: permanent` directly after the status line; otherwise set each `error_class:` line to `error_class: permanent`. Other frontmatter lines are untouched.
  - Stamp = `<UTC date YYYY-MM-DD of today>: abandoned; no activity for >30 days, closed by stale-log policy`.
  - Body: if the body already contains the text `## Error Log`, append an empty line and the stamp (plain, no bullet) at the end. Else if a line starts with `## Related`: insert `""`, `## Error Log`, `""`, `- <stamp>`, `""` before the next `## ` line after Related, or at the end of the body (in which case trailing blank lines are then removed). Else append `""`, `## Error Log`, `""`, `- <stamp>` at the end.
  - Write `["---", ...fm, "---", ...body].join("\n") + "\n"`.

## 18. .githooks/pre-commit

A bash script (`#!/usr/bin/env bash`, `set -euo pipefail`, compatible with bash 3.2: no associative arrays, no `mapfile`, no unguarded expansion of empty arrays under `set -u`). It is stored with LF endings and committed executable, and runs with `core.hooksPath = .githooks`. Steps:

1. `cd "$(git rev-parse --show-toplevel)"`.
2. Read the staged `*.md` paths with `git diff --cached --name-only -z --diff-filter=ACMR -- '*.md'` (NUL-delimited, `read -r -d ''`) and classify each; the first matching rule wins (`case` patterns, where `*` also matches `/`):
   - `agents/*/reports/archive/*` → ignored
   - `agents/*/reports/*.md` → **logs**
   - `*/index.md`, `dashboard/*`, `scripts/*`, `.claude/*`, `.agents/*` → ignored
   - `*/*.md` → **notes**, and its first path component (`${f%%/*}`) joins the folder list
   - anything else (root-level `.md` files such as `AGENTS.md`) → ignored.
3. `removed` = `git diff --cached --name-only --diff-filter=DR -- '*.md'` (deleted or renamed notes can break links elsewhere). If there are no logs, no notes and no `removed`, exit 0 immediately.
4. If `bun` is not on `PATH`: print `pre-commit: bun not found on PATH, so notes cannot be validated; commit refused` to stderr and exit 1.
5. Run, each aborting the commit on failure: `bun scripts/validate-logs.ts <logs...>` if there are logs; `bun scripts/validate-vault.ts <notes...>` if there are notes; always `bun scripts/validate-vault.ts --links` (whole-vault link check).
6. If there are note folders: take the unique sorted first components, run `bun scripts/index.ts <folders...> >/dev/null` (index.ts ignores folders not in `vault.config.json`), then for each such folder with an existing `<folder>/index.md`, run `git add -- <folder>/index.md`.
7. Exit 0.

Check the script with `bash -n` (and `shellcheck` if available). Mark it executable in git (`git update-index --chmod=+x .githooks/pre-commit`) so macOS and Linux clones keep the bit; `.gitattributes` (`* text=auto eol=lf`) keeps it LF.

## 19. scaffold.ts (`.claude/skills/new-agent-log/scripts/scaffold.ts`)

Creates a new agent log at `status: active`. Shebang `#!/usr/bin/env bun`. Uses `util.parseArgs` (an unknown flag throws a plain error, exit 1). Options: `--task` (required), `--title`, `--slug`, `--priority` (default `medium`), `--agent` (default `claude-code`), `--date`, `--root` (default `.`), `--force` (boolean). Validation runs in this order; each failure prints `scaffold: <message>` to stderr and exits 2:
1. no `--task` → `--task is required`
2. priority not `high|medium|low` → `--priority must be high, medium or low`
3. `date = --date ?? <local today YYYY-MM-DD>`; not matching `^\d{4}-\d{2}-\d{2}$` → `--date must be YYYY-MM-DD`
4. `slug = slugify(--slug ?? task)`; empty → `could not derive a slug; pass --slug`. `slugify`: lowercase, replace each run of non-`[a-z0-9]` with `-`, strip leading and trailing `-`, keep only the first 6 dash-separated words.
5. agent not matching `^[a-z0-9][a-z0-9-]*$` → `--agent must be lowercase and hyphenated`
6. Path = `<resolve(root)>/agents/<agent>/reports/<date>-<slug>.md`; if it exists and no `--force` → `<root-relative path> exists; edit it, or pass --force`.

Title = `--title`, or the slug with each dash-separated word capitalised and the words joined by spaces (`dns-api` gives `Dns Api`). `task` is written with every `"` replaced by `\"`. File content, exactly (LF, single trailing newline; `<…>` are substitutions):

```
---
updated: <date>
tags: [agent-log]
type: agent-log
agent: "<agent>"
status: active
task: "<task>"
priority: <priority>
date: <date>
---

# <title>

## Summary
_(fill in when the task ends)_

## Notes
_(none yet)_

### Verification
_(fill in: each check run and its result)_

## Related
_(none yet)_
```

Create the parent folders, write the file, and print the root-relative path with forward slashes (the only stdout output), exit 0. The scaffold passes `validate-logs.ts` while `active`; flipping it to `completed` without replacing the Verification placeholder is rejected (the placeholder matches the `_(…)_` rule).

## 20. test-fixture.ts

- `FixtureVault = {root: string, d: Derived, write(rel, content): string, cleanup(): void}`.
- `makeVault()`: `root = mkdtempSync(join(tmpdir(), "vault-test-"))`; writes `vault.config.json` as `JSON.stringify(CONFIG, null, 2)` with `CONFIG = {name: "fixture", semantic_dirs: {infra: "infrastructure", project: "projects"}, episodic_dirs: {decision: "decisions"}, extra_dirs: [], edge_types: []}` (note: no `personal` semantic dir); creates the folders `infrastructure`, `projects`, `decisions`, `agents/tester/reports` (recursive); `d = derive(loadConfig(root))`. `write(rel, content)` creates the parent folders, writes UTF-8 and returns the absolute path `join(root, rel)`. `cleanup()` removes `root` recursively and forcibly.
- `note({type, updated, title, notes?, related?}): string` returns exactly
  `---\nupdated: <updated>\ntags: [<type>]\ntype: <type>\n---\n\n# <title>\n\n## Summary\nFixture note.\n\n## Notes\n<notes>\n\n## Related\n<related>\n`
  where `<notes>` is each notes entry as `- <entry>` joined by `\n` (an empty string when there are none, leaving two blank lines before `## Related`), and `<related>` is the `related` entries joined by `\n` **as given** (callers include their own `- ` prefix), defaulting to `_(none yet)_`.
- `agentLog({date, status, task, related?, extra?, verification?}): string` returns exactly
  `---\nupdated: <date>\ntags: [agent-log]\ntype: agent-log\nagent: "tester"\nstatus: <status>\ntask: "<task>"\npriority: low\ndate: <date>\n<completion><extra>---\n\n# <task>\n\n## Summary\nFixture log.\n\n## Notes\n- <date>: did the thing.\n<verification>\n## Related\n<related>\n`
  with `<completion>` = `completion_signal: true\nverified: false\n` only when `status === "completed"` (else empty); `<extra>` = the `extra` string verbatim (default empty; callers pass whole lines ending in `\n`); `<verification>` = `\n### Verification\n- ` + backtick-quoted `bun test` + ` -> 3 pass, 0 fail\n` when the status is `completed` and `verification !== false` (else empty); `<related>` as in `note`. The agent name in a fixture log is `tester`; fixture dates are always explicit.

## 21. Test traceability

Each assertion below maps to a section above (`§` = section of this document).

**frontmatter.test.ts**
- parseFrontmatter split, null without leading `---`, null without closing `---`: §7 Line splitting (`fm`, `body[0] === ""`, exact `---`).
- extractField / fmLineNo (`type` → `project`, absent → `null`, line 4 = fmStart 2 + index 2, notFound `-1`), tags inline: §7 Scalar and list fields.
- isValidCalendarDate: §7. splitLines BOM (line 0 is `---`, fields readable afterwards) and no-BOM: §7.
- extractFmLists (inline, block with scalar key ignored, uniform with edges giving `["type: relates-to"]`, bracket-less scalar, empty): §7 examples.
- extractEdges targets: bare id gives `{target, link}` and no errors; the wiki-link target gives the exact retired-syntax message and no edges; the `.md`, leading-slash, `../`, `#` and `|` targets give the messages of rules 3 to 7 (substring checks): §7 Typed edges. A YAML plain scalar `projects/example-app#section` keeps its `#` (no space before it); quoted values keep their text.
- checkRetiredWikiLinks (line 11 for start 10, code ignored, clean body, `[[#Setup]]`): §7 Body checks. checkBodyPaths (two errors, first at line 10; code ignored): §7 Body checks.

**links.test.ts**: extraction order, lines and hrefs (title and `<>` stripped, nested brackets, image, inline code and fence skipped, `[[wiki]]` not a link); `raw` and `index` from the original text; `vaultLinks` filtering and anchor split; `blankCode` keeps length and line count; percent decoding: §6 `extractLinks`, `blankCode`, `vaultLinks`. `isExternal`, `splitHref`, `resolveHref` (backslash `fromRel`, `./`, escape, absolute, external, anchor), `hrefFor` (inverse property, no `./`), `slugAnchor` (all cases), `mdLink` (`<…>` wrapping, tricky-title round trip, `escapePipe`), `lineIndex`: §6 function table. `WIKI_LINK_RE` groups (plain, heading, alias, empty target, `\|` alias): §6 regex table.

**validators.test.ts**
- validateVaultNote clean note (`rel` = `projects/alpha.md`): §9 (the fixture note passes every rule; `project` is valid).
- unknown type and impossible date (messages mention `type` and `updated`; all lines at least 1; the file ends with a newline so there are no line-0 errors): §9 steps 2 and 4.
- absolute path in the body; the exact wiki-link message; retired-wiki-link edge target; `.md` edge target: §9 steps 5 and 6, §7.
- checkLinks body links (same folder, subfolder up, anchor, attachment, missing file with the exact `— no file at projects/ghost.md`, case mismatch, escape, root-absolute, dot-directory, `.git` not indexed, `.claude/` not linted as a source, directory links with and without a slash, missing directory, extensionless attachment, fenced code ignored): §9 `buildResolver`, `checkLinks` steps 1 and 3.
- edge targets (resolves; `broken edge target projects/ghost — no matching note`): §9 `checkLinks` step 2.
- gitignored targets (five `isGitIgnoredLinkTarget` calls, directory target, links not broken, and broken when no rule exists): §9 `isGitIgnoredLinkTarget`. These tests run `git init -q` in the fixture.
- validateAgentLog: clean completed log; error status messages mention `error_class` and `Error Log`; completion_signal rules (live versus archive, `false`, `yes`); the `### Verification` cases (none, placeholder, outside Notes, real, fenced, `verified` missing); filename; wiki-link; inline comments; block tags and `not-agent-log`; one H1, order, fenced `#`; Error Log as H3 versus H2; absolute paths of five shapes versus inline code: §8 steps 1 to 13 and `hasVerificationEvidence`.
- `--hook`: exit 0 for `_format.md`; exit 2 with stderr containing `missing required frontmatter field` for a log written under `<vault>/agents/hook-test/reports/`: §8 CLI `--hook`.

**capture.test.ts**: `resolvePath` (four cases; the episodic file is `decisions/2026-09.md` for the local date 2026-09-07): §10. `insertBullet` (exact `- 2026-01-01: first\n- 2026-09-07: shipped v2\n\n## Related`, `updated:` bump, validator-clean; a missing `updated:` gets `---\nupdated: 2026-09-07\n` at the top; rejection restores the exact original and throws `validator rejected`): §10 steps 2 to 5. `createNote` validator-clean and contains `# New Node`: §10.

**consolidate.test.ts**: archival selection, archive exclusion, exact-90-day exclusion (today 2026-09-07 gives threshold 2026-06-09): §12 `findArchivalCandidates`. Distillation (older note flagged, newer not, dedup, episodic ignored): §12. `archiveLogs` with apply: the moved file contains `[AGENTS](../../../../AGENTS.md)`, `projects/p.md` contains the `archive/` link, no broken links; the fixture is not a git repo so the move is a plain rename: §11, §12.

**move-note.test.ts**: outbound `../` gain, sibling `../other.md`, anchor kept, fenced code and escaping link byte-identical (`changed` false, `linksChanged` 0, text identical): §11 outbound. Inbound re-pointing, sibling gaining `archive/`, edge id rewrite with the `context` line preserved and 4-space indentation kept, unrelated file absent from `inbound`: §11 inbound and edge rewrite. `applyMove` plain rename (old path gone, new content rewritten), `git mv` (porcelain `R  <from> -> <to>`), throws for a missing source with `outbound === null`: §11. End-to-end link-clean: §11, §9.

**dashboard-search.test.ts**: grouping, headings with counts, the link `[Beta](../agents/tester/reports/2026-10-02-b.md)`, escaped pipe, not starting with `---`, `render` contains `Active (1)`, empty vault renders all five titles: §15. Search finds only `projects/demo.md` (the `personal/` note by the path rule, the flagged note by the frontmatter flag): §14, §4 `isRestricted`.

**review-fixes.test.ts**: `isRestricted` five positive forms, BOM, `false`: §4. `notesInDir` excludes the restricted note and returns the titles `["Open"]`; search ignores `projects/index.md`: §13, §14. `extractField` quoted-then-comment cases and `#` inside quotes: §7. `extractFmLists` with a trailing comment: §7. Duplicated section message contains `appears 2 times`: §7 `checkHeadings`. `addCommitSha`, three cases: §16.

Specified above although no test pins them, so the behaviour is reproducible: every CLI usage string, `stale-logs` output and edit, the `commit-task` message layout, the pre-commit classification, the `index.ts` layout, `validate-vault --json`, the `## Notes` split warning, and `scaffold.ts` output and error text.

## 22. Traps

- **Windows separators.** `Bun.Glob`, `path.relative` and `path.join` emit `\`. Normalise with `toPosix` before any segment split, regex or equality (`inSkippedSubtree`, `isRestricted`, the `agents/<a>/reports/` pattern, archive filters, `rel` in validator output). Paths printed in messages are forward-slash.
- **Dot directories.** `buildResolver` and `move-note` scan with `dot: true`; `search.ts` and `findAgentLogs` do not. Never index `.git` internals.
- **Temp directories.** The tests build vaults in the OS temp dir. `index.ts` computes the restricted path relative to the script's own vault root (not the folder's vault), so for a fixture folder only the frontmatter flag is effective; do not make `notesInDir` depend on the folder lying inside the script's vault. The `git mv` test and the plain-rename tests assume the temp folder is not itself inside another git work tree.
- **CRLF and BOM.** `splitLines` tolerates both. Writers (`capture`, `commit-task`, `stale-logs`) emit LF and drop a BOM; only `move-note` preserves original line endings byte for byte (raw-line splitting, never `splitLines`).
- **YAML.** `Bun.YAML.parse` turns a bare `2026-01-01` into a `Date`; `extractEdges` accepts a `Date` or a string. The line-based helpers (`extractField`, `extractTagsList`, `extractFmLists`) never use YAML; only `extractEdges` does, and only when a column-0 `edges:` line exists, so notes without edges cannot be broken by a YAML error.
- **`extractField` is not column-0 anchored.** It matches any line whose trimmed text begins with `key:`, and the first one in file order wins. Edge entries (`    type: depends-on`) therefore must not precede the real top-level `type:`; the schema puts `type:` first and the validators rely on that.
- **Hook stdin.** Read it synchronously (`readFileSync(0)`), not with an awaited `Bun.stdin` call under `runMain`.
- **Bash 3.2.** The pre-commit script avoids `mapfile` and expands arrays only after a length check.
- **Local versus UTC dates.** `capture` and `consolidate` use the local calendar date; `stale-logs` computes age with the local date but writes its stamp with the UTC date (`toISOString`). Reproduce as written; tests only cover the former.
- **Git inside tests.** The tests run `git init -q` (plus `git config user.email` and `user.name` where they commit). The tooling needs no git configuration beyond what `git commit` normally needs.
