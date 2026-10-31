# Rebuild spec for the guard scripts

This file describes `shell-parse.ts`, `shell-guard.ts` and `read-guard.ts` closely enough to write them again from scratch and pass `shell-guard.test.ts` and `read-guard.test.ts`. The guide is [../README.md](../README.md). Where a rule says "exactly", the exact behaviour matters to a test or to another module.

Conventions: TypeScript, run with Bun, ES modules, imports written with the `.ts` extension (`import … from "./shell-parse.ts"`). A CLI entry is guarded by `if (import.meta.main)`, so importing a module never runs it. Tests use `bun:test`.

## Module map

| Module | Imports | Exports |
|---|---|---|
| `shell-parse.ts` | nothing | `Seg`, `Scan` (types), `scan`, `base`, `firstWordIndex`, `commandIndex` |
| `shell-guard.ts` | `shell-parse` | `SECRET_COMMANDS`, `secretVerdict`, `envVerdict`, `chainVerdict`, `evaluate`, `decide` |
| `read-guard.ts` | `shell-parse` | `readVerdict`, `decide` |

A **verdict** is `string | null`: a reason text means deny, `null` means allow. The tests import `chainVerdict, decide, envVerdict, secretVerdict` from shell-guard and `decide, readVerdict` from read-guard.

## CLI entry (both guards)

1. Read all of stdin as text with `await Bun.stdin.text()` written directly at module top level inside the `if (import.meta.main) { … }` block, i.e. `const reason = decide(await Bun.stdin.text());` (not inside a helper function: on Windows a nested awaited stdin read has let Bun exit 0 early).
2. Call `decide(raw)`.
3. If it returns a reason, print one line of JSON to stdout: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"<guard>: <reason>"}}`, where `<guard>` is `shell-guard` or `read-guard`. If it returns `null`, print nothing.
4. Always exit 0.

`decide` never includes the `<guard>: ` prefix; only the CLI adds it.

## shell-parse.ts

`scan(src: string): Scan` splits a Bash or PowerShell command into simple commands. It is a small scanner, not a full parser.

```ts
interface Seg  { words: string[]; captured: boolean; sepAfter: string; top: boolean }
interface Scan { segs: Seg[]; breaks: number }
```

### What a segment is

A **segment** is one simple command: its words with quoting removed (`'a b'` and `"a b"` are one word `a b`). A segment is only recorded when it has at least one word.

| Field | Meaning |
|---|---|
| `words` | The words, quotes and escapes resolved. A command or process substitution inside a word is replaced in that word by the literal text `$()`. |
| `sepAfter` | What ended the segment: `;`, `&&`, `\|\|`, `\|`, `&`, `"\n"`, `)` (closing a substitution or subshell), or `""` (end of input). |
| `top` | `true` when the segment is at nesting depth 0, `false` when it sits inside `$( )`, `( )` or backticks. |
| `captured` | `true` when this command's stdout is assigned to a variable instead of printed (see "captured"). |

`segs` is in completion order: a nested segment ends (and is recorded) before the segment that contains it, so inner segments come first. For `echo $(gh auth token)` the order is `gh auth token`, then `echo $()`.

A segment ends at any separator even if it has no words yet (empty ones are simply dropped). After a segment ends, `captured` goes back to the value the body was opened with (so `X=$(a; b)` captures both `a` and `b`, but see "captured" for what is not inherited).

### Reading the input

The scanner walks the text one character at a time inside a recursive function `body(depth, capturedCtx)`. Entry: `body(0, false)`. Each call keeps its own current word, current segment words and heredoc queue, and shares the read position and the `segs` list. At end of input the open segment ends with `sepAfter ""`. Rules apply in this order:

1. **`)` at depth above 0** ends the current segment with `sepAfter ")"` and returns to the caller. At depth 0 a `)` is an ordinary character.
2. **Backslash.**
   - Followed by a newline, or by `\r\n`: the pair is dropped, no word break, no token (a line continuation).
   - Otherwise, if the next character is one of ``\ space tab " ' $ ` ; & | ( ) < > # \n \r``, the backslash is dropped and that character is added literally to the word. Starting such a word counts as a token.
   - Any other next character (or end of input): the backslash itself is a literal character. This keeps Windows paths such as `C:\Users\x` intact.
3. **Single quote** starts a literal run up to the next `'`, or to the end of input if there is none. The run is appended to the current word. The word exists even if empty, so `''` is an empty word.
4. **Double quote** starts a run up to the next unescaped `"` (or end of input). Inside it:
   - A backslash followed by any character adds that next character only (so `\"` gives `"`, `\n` gives the letter `n`); a backslash with no following character is literal.
   - `$(` descends: the nested body runs at depth+1 and the word gets `$()`. It is `captured` only when the quote directly follows an assignment (the word so far ends with `=`) and `$(` is the very first thing inside the quotes: `X="$(cmd)"`.
   - A backtick with a closing backtick later in the text: the text between is scanned recursively with a fresh `scan`, its segments are added with `top: false` (their own `captured` kept), and the word gets `$()`. A backtick with no closing one is a literal character.
   - Everything else, including spaces and `;`, is added literally.
5. **Backtick outside quotes** with a closing backtick: scan the inside recursively; add its segments with `top: false` and `captured` set to (its own captured OR the assignment test below); the word gets `$()`. Without a closing backtick it is a literal character. The closing backtick is simply the next backtick (plain search, no escape handling), in quotes or not.
6. **`$(`**: command substitution. `captured` is the assignment test, then the nested body runs at depth+1 and the word gets `$()`.
7. **`(` at the start of a word** (no word in progress): a subshell or PowerShell grouping, handled exactly like `$(` but consuming one character. A `(` in the middle of a word is a literal character, so `<(git log)` stays a word `<(git` followed by `log)`.
8. **`#` at the start of a word** is a comment: skip to the end of the line (the newline is kept). A `#` inside a word is literal.
9. **Space, tab, `\r`** end the current word.
10. **Newline** (see "breaks" below for the counting) ends the segment with `sepAfter "\n"`, even inside a substitution. Then any queued heredoc bodies are skipped (below).
11. **Heredoc** `<<`: only when the character after the `<<` pair is not `<` and the character before it is not `<` (so `<<<` is never a heredoc). The text must match `<<`, optional `-`, optional whitespace, then a tag that is `'…'`, `"…"` or a bare run of characters other than whitespace and `; & | ( ) < >`. The whitespace between the operator and the tag is any whitespace, newlines included, so `<<\nEOF` takes `EOF` as the tag (an unquoted tag also stops at the first of those excluded characters). On a match, queue the tag (with a "strip tabs" flag when `-` was present), consume the operator and tag so neither becomes a word, and count it as a token. The word in progress is not ended: `cat<<EOF` leaves the word `cat` open (it ends at the next space), so it yields the word `cat`, not `cat` plus anything from the operator. If it does not match, `<` is an ordinary character. Quoted or not, the body is always skipped and never scanned.
12. **`;`, `|`, `&`**:
    - `&` directly after `>` or directly before `>` is part of a redirection (`2>&1`, `>&2`, `&>file`): it is appended to the current word.
    - PowerShell call operator: an `&` not followed by `&`, with no word in progress, when the segment is empty or its last word is `=`, is dropped silently (`& cmd`, `$x = & cmd`); it is not a token, so it does not affect break counting.
    - Otherwise the operator is `&&`, `||` or the single character. The segment ends with that `sepAfter`.
13. **Anything else** is appended to the current word.

`>` and `<` are not separators: `cat a > b` gives words `cat`, `a`, `>`, `b`, while `cat f &>/dev/null` gives `cat`, `f`, `&>/dev/null` and `2>&1` is one word.

### captured

The **assignment test** is: if a word is in progress, does it end with `=`; if not, is the previous word of the segment present and ending with `=`. The second case covers PowerShell `$x = $(cmd)` and `$x = (cmd)`, where `=` is its own word. So these are captured: `NAME=$(cmd)`, `NAME=\`cmd\``, `export T="$(cmd)"`, `$x = (cmd)`. These are not: `echo $(cmd)`, `curl "A: $(cmd)"` (the `$(` is not first after `=`), a bare `$(cmd)`.

**Exact rule for a new body** (`$( )` or a word-start `( )`): its starting `captured` value is the assignment test alone. It is not OR-ed with the captured flag of the body it appears in, so capture does not propagate into a nested substitution: in `X=$(a; (b))` and in ``X=$(a `b`)`` the segment `b` is not captured, while `a` is. A backtick scan starts uncaptured, and its segments get `captured = own flag OR assignment test` (the test is made in the body containing the backtick, outside quotes only; backticks inside double quotes never add capture, whatever precedes the quote).

The captured flag is for the substituted command only. In `TOKEN=$(gh auth token) curl …` the `gh` segment is captured and the `curl` segment is not.

### top

`top` is `true` for every segment recorded by the depth-0 call, and `false` for anything recorded at depth 1 or deeper, or from backticks. A backtick scan is a separate `scan` call whose own segments say `top: true`, so the caller overwrites them with `false`. Only the depth-0 call counts newlines.

### breaks

`breaks` counts top-level newlines between two statements that are not joined. It is only advanced at depth 0.

- A newline on a line that had no token (blank line or comment-only line) counts for nothing.
- A newline that follows a trailing `&&`, `||` or `|` (nothing since the operator except spaces) does not count: that line is joined to the next.
- A trailing `;` does not join. `a;\nb` is one break.
- Otherwise the newline is a pending break. It only becomes a counted break when the next token arrives on a later line, so trailing newlines at the end of the input add nothing.
- A token is any character or quote that becomes part of a word, a substitution, or a heredoc operator; whitespace and comments are not tokens. Seeing a token also clears the remembered "last operator". Any depth-0 separator (`;`, `&`, `&&`, `||`, `|`) sets it, but only `&&`, `||`, `|` join, and only when the line ended with no word in progress, so `a\n&& b` counts a break (the `&&` is not a token, but `b` is).
- Backslash-newline continuation joins lines and counts nothing.
- Newlines inside `$( )`, `( )`, backticks and heredoc bodies never count, because they are at depth 1 or are skipped.

`git add -A\ngit commit` gives 1. `git add -A &&\ngit commit` gives 0. `git commit -m "$(cat <<'EOF'\nline\n\nmore\nEOF\n)"` gives 0.

### Heredoc bodies

When a newline is read, each queued heredoc (in queue order) skips lines from the current position until a line equals its tag, then stops after that line; the terminator line's own newline is consumed too (so the segment after the heredoc starts on the next line, and that newline is not counted as a break or a segment end); a missing terminator makes the scanner skip everything to the end of the input, with no error. The comparison drops a trailing `\r`; with the strip flag it also trims leading and trailing whitespace. Heredocs queued inside a `$( )` are consumed by the newline inside that same `$( )`.

### Helpers

| Function | Behaviour |
|---|---|
| `base(word)` | Last path component (split on `/` or `\`), with one trailing `.exe`, `.cmd`, `.bat`, `.ps1`, `.ts` or `.js` removed (any case), lower-cased. `/usr/bin/GH.exe` gives `gh`. |
| `firstWordIndex(words)` | Index of the first word that is not a keyword, a lone `&`, or an environment assignment (`^[A-Za-z_]\w*=`). If `words[0]` is `case`, start after the first word that ends with `)` (the pattern), or at `words.length` when none does. |
| `commandIndex(words)` | Start at `firstWordIndex`, then keep skipping while the word is a keyword, an env assignment, a wrapper (by `base`), starts with `-`, or looks like a duration (`^\d+[smhd]?$`). The result may equal `words.length`. |

Keywords: `if then elif else fi for while until do done case esac in { } ( ) ! time`.
Wrappers: `env command exec time nohup timeout xargs sudo nice builtin { ! call start export`.

So `timeout 5 op read x` has command index 2, `FOO=1 env BAR=2 gh auth token` has command index 3, `if gh auth token` points at `gh`, and `case x in a) gh auth token` points at `gh`. Callers always write `words[k] ?? ""` because `k` can run off the end.

## shell-guard.ts

**Reason texts, literal versus filled in.** Secret rule: `<cli>` and the path are the actual matched CLI and subcommand path (backtick-quoted), and the hint text, including `TOKEN=$(gh auth token) some-cmd`, is always the same literal. Env printing rule: `$NAME` in `[ -n "$NAME" ]` is literal text, not the variable found. Dump rule: `<cmd>` is the actual command word, `printenv NAME` is literal. Chain rule: fully literal. Tests only match the substrings `gh auth token`, `denied` and `Read tool`.

Applies to tools `Bash` and `PowerShell` (chain rule: `Bash` only). Every verdict function returns `null` for any other tool name.

### Exports

| Name | Signature | Notes |
|---|---|---|
| `SECRET_COMMANDS` | `Record<string, string[]>` | Table below. |
| `secretVerdict` | `(tool, command) => string \| null` | Rule 1. |
| `envVerdict` | `(tool, command) => string \| null` | Rule 2. |
| `chainVerdict` | `(tool, command) => string \| null` | Rule 3. |
| `evaluate` | `(tool, command) => string \| null` | First non-null of secret, env, chain, in that order. |
| `decide` | `(raw: string) => string \| null` | Hook JSON in, reason out. |

### decide

1. `JSON.parse(raw)`. `tool_name` is `String(input?.tool_name ?? "")`; the command is `String(input?.tool_input?.command ?? "")`. Return `evaluate(tool, command)`.
2. Any exception inside that `try` (bad JSON, or anything thrown by the rules) is handled in the `catch`: if the raw text matches the case-sensitive, flagless `\b(gh|op|bw|vault|aws|gcloud)\b` (the keys of `SECRET_COMMANDS`), return `could not parse a command that mentions a secret CLI, so it is denied.`; otherwise return `null`. This is the fail-closed rule.

So `decide("not json gh auth token")` contains `denied`, `decide("not json")` is `null`, and `decide` of valid JSON with command `ls` is `null`.

### Rule 1: secret CLIs

`SECRET_COMMANDS` (CLI name to subcommand paths, words joined by one space):

| CLI | Denied subcommands |
|---|---|
| `gh` | `auth token` |
| `op` | `read`, `item get`, `inject` |
| `bw` | `get`, `list`, `export` |
| `vault` | `read`, `kv get` |
| `aws` | `configure get`, `secretsmanager get-secret-value` |
| `gcloud` | `auth print-access-token`, `secrets versions access` |

Printers (commands that put their arguments or input in the transcript): `echo printf print cat tee jq head tail less more base64 xxd write-host write-output`.
Shells that run a string: `bash sh zsh dash pwsh powershell cmd eval iex invoke-expression`.

`analyze(src, out, depth)` scans `src` and checks each segment:

1. **Printing context.** `printsArgs` is true when some top-level segment's command word (`base` of `words[commandIndex]`) is a printer. This is what makes `echo $(gh auth token)` bad.
2. **PowerShell assignment.** If the segment starts with a word like `$name` (matches `^\$[\w:.]+$`) followed by the word `=`, drop those two words and treat the segment as captured. The later steps use the stripped words (including the redirect test), but step 1 and the next-segment test in step 4 use each segment's raw words.
3. **Find the CLI.** `k = commandIndex(words)`, `cli = base(words[k])`. The subcommand test looks at the words after `k`, drops every word starting with `-`, and looks for a path as a consecutive run anywhere in what remains. That lets global flags and their values sit in between (`gh --repo a/b auth token`, `aws --profile dev secretsmanager get-secret-value`, `bw --session abc get password x`). It returns the matching path or no match. Use own-property lookup on `SECRET_COMMANDS`.
4. **On a match, it is safe when any of these holds:**
   - the segment is `captured`;
   - it is redirected: some word matches `^\d?>>?[^&]*$` and is not `>&2` and does not end in `&1` (`> token.txt`, `>>f`, `2>err`);
   - it is piped (`sepAfter` is `|`) into the next segment in the list and that segment's command is not a printer (and the next segment exists). `gh auth token | docker login …` is safe; `| cat`, `| jq .`, `| tee` are not;
   - it is not top-level and `printsArgs` is false (an argument to a command that does not print).
   Otherwise add the reason `` `<cli> <path>` prints a secret into the transcript. Pass the value to the command that needs it without printing it, e.g. `TOKEN=$(gh auth token) some-cmd`. `` (the path is the matched subcommand path).
5. **No match and the CLI is a shell** (and `depth < 4`): rebuild the inner text from the words after `k`, dropping words that match `^(-\w+|\/c)$` (any case) such as `-c`, `-Command`, `/c`, join them with spaces, and `analyze` that with `depth + 1`. This is how `bash -c 'gh auth token'`, `pwsh -Command "op read x"` and `eval "…"` are seen.

`secretVerdict` returns the first reason found, or `null`.

### Rule 2: environment

`SECRET_ENV` matches a variable name, case-insensitively (flag `i`), that ends in a secret word. It is built from two word lists:

| Kind | Rule | Words |
|---|---|---|
| Suffix words | May follow any `[A-Z0-9_]*` prefix | `PASSWORD`, `PASSWD`, `PASSPHRASE`, `DBPASS`, `DB_PASS`, `TOKEN`, `SECRET`, `SECRET_KEY_BASE`, `SESSION`, `CREDENTIAL`, `CREDENTIALS`, `PRIVKEY`, `AUTHORIZATION`, `API_KEY`, `APIKEY`, `API`, `PRIVATE_KEY`, `ACCESS_KEY`, `SIGNING_KEY`, `ENCRYPTION_KEY`, `MASTER_KEY`, `<X>_URL` / `<X>_URI` for X in `DATABASE DB MONGO MONGODB REDIS POSTGRES POSTGRESQL AMQP WEBHOOK`, `CONNECTION_STRING`, `CONN_STR` |
| Segment words | The whole name, or after an underscore (`(?:[A-Z0-9_]*_)?WORD`) | `KEY`, `PASS`, `PWD`, `AUTH`, `CREDS`, `JWT`, `BEARER`, `COOKIE`, `PAT`, `OTP`, `TOTP`, `SALT`, `DSN` |

Pattern: `\b(?!PWD\b)(?:[A-Z0-9_]*(?:<suffix words>)|(?:[A-Z0-9_]*_)?(?:<segment words>))(?:_V?\d+)?\b`, alternatives joined with `|` in the order listed, flag `i`. The secret word must end the name (the trailing `\b`), except for an optional version tag such as `_V2` or `_2`. The lookahead excludes the bare name `PWD`, the current directory.

Match: `GITHUB_TOKEN`, `github_token`, `token`, `Api_Key`, `OPENAI_APIKEY`, `STRIPE_API`, `DB_PASSWORD`, `DB_PASS`, `db_pwd`, `DEPLOY_KEY`, `KEY`, `GITHUB_PAT`, `SENTRY_DSN`, `DATABASE_URL`, `MONGODB_URI`, `SLACK_WEBHOOK_URL`, `BASIC_AUTH`, `SESSION_COOKIE`, `MFA_TOTP`, `SECRET_KEY_BASE`, `CI_JOB_JWT_V2`, `DBPASS`, `AUTHORIZATION`, `REACT_APP_API` (bare `API` counts, so base-URL names ending in `_API` are denied too). No match: `tokenizer`, `API_BASE_URL`, `apiary`, `SESSIONS_DIR_COUNT`, `BYPASS`, `MONKEY`, `PWD`, `OLDPWD`, `PATH`, `OAUTH`, `COMPASS`, `HOTKEYS`, `AUTHOR`, `SITE_URL`, `NODE_V18`, `PASSES`. Segment words match after any underscore, so `CACHE_KEY` and `OLD_PWD` are denied too (printing them is rarely needed).

`envVerdict` works on a cleaned copy of the command:

1. Remove quoted heredoc bodies (replace with one space): the pattern is `<<` with optional `-` and spaces, a tag in matching single or double quotes, the rest of that line, then everything up to a line that is only that tag (leading spaces allowed) at a newline or the end. Unquoted heredocs are not removed. Between `<<-?` and the quote any whitespace is allowed. The body needs at least one newline before the terminator line, so a heredoc whose terminator is the very next line (empty body) is not removed. The tag is `\w+` only; the terminator line may have leading whitespace but nothing after the tag (a trailing space means it is not a terminator); the body is matched lazily up to the first such line; the match is replaced by one space. With no terminator line the pattern does not match, so nothing is removed and the body is tested as ordinary text (unlike `scan`, which would skip it).
2. Remove single-quoted text, only outside double quotes. Walk the characters: a `"` not preceded by a backslash flips an in-double flag; a `'` outside double quotes with a later closing `'` is replaced (with the text between) by one space; an unmatched `'`, or any `'` inside double quotes, stays. So `echo "it's" $GITHUB_TOKEN "don't"` still shows the variable.

**Printing test** (one regex, flags `mi`: multi-line and case-insensitive), on the cleaned text. A *reference* is `$NAME`, `${NAME}`, `$env:NAME` or `%NAME%`, where NAME matches `SECRET_ENV`. Deny with `This prints a secret-looking environment variable. Test it with `[ -n "$NAME" ]` or pass it to the command that needs it.` when any of these is found:
- one of `echo`, `printf`, `print`, `write-host`, `write-output` in any letter case (`Echo`, `Write-Host`, `WRITE-HOST` all match), delimited by a plain `\b` (so `-print` or `/echo` also match), then any characters except `; & | newline`, then a reference. The reference must come after the printer and before the next separator, so `[ -n "$TOKEN" ] && echo set` passes and `curl -H "Bearer $TOKEN"` passes;
- `printenv`, whitespace, then a secret name (`printenv AWS_SECRET_ACCESS_KEY`);
- a lone `$env:NAME` that makes up a whole statement (line start or after `; & | newline`, then end or the next separator), which PowerShell prints; whitespace is allowed around it and "end" is end of line (`$` under flag `m`).

The regex is not run once on the cleaned text but on each of its **parts**, from `substitutionParts(tool, text)` (not exported); deny if any part matches. This keeps `echo $(curl -H "Bearer $TOKEN" x)` (which prints curl's output, not the token) from being denied, while failing closed on anything it cannot take apart:
- For any tool but `Bash`, the parts are `[text]`. PowerShell's `$( )` is a subexpression whose value is printed, so `Write-Host "$($env:GITHUB_TOKEN)"` stays denied.
- For `Bash`, if the text contains a backslash followed by `$` or a backtick (`/\\[$\x60]/`), the parts are `[text]`: an escaped `\$(` is literal, so `echo "\$(curl $TOKEN)"` prints the token.
- Otherwise, repeat up to 50 rounds on a working copy `rest` (starting as `text`): replace every match of `/\$\((?!\()[^()\x60]*\)|\x60[^\x60\\]*\x60/g` (an innermost `$( … )` with no parentheses or backticks inside and not `$((`, or a backtick pair with no backslash inside; `\x60` is a backtick) with ` _ `, pushing its body (without `$(`/`)` or the backticks) onto a list. When a round changes nothing: if `rest` still contains `(`, `)` or a backtick, the parts are `[text]`; otherwise they are `[rest, ...bodies]`. After 50 rounds that all changed something, the parts are `[text]`.

So `echo $(a $(b "$TOKEN"))` and `` echo `curl "$TOKEN"` `` pass; `echo "$(date) $TOKEN"`, `echo $(echo $TOKEN)` (the body matches on its own), `curl -H "$(printf %s "$KEY")" x`, and anything left unbalanced (`echo $(foo "(") $TOKEN`, `$((…))`, an escaped backtick, an unclosed `$(`) are denied because the whole text is tested.

**Dump test**, on the original command's segments (not the cleaned text). For each segment: compute `k = firstWordIndex(words)` (not `commandIndex`), `cmd = base(words[k])`, `args = words.slice(k+1)`. Skip the segment when `sepAfter` is `|` (a filtered dump, `env | grep PATH`, `printenv | wc -l`). Otherwise it is a dump when:
- `cmd` is `printenv`, `env` or `set` with no args; or
- `cmd` is `export` with no args or `args[0] === "-p"`; or
- `cmd` is one of `get-childitem gci ls dir get-item gi` with exactly one arg matching `^env:[\\/]?\*?$` (any case).

Deny with `<cmd> with no filter dumps every environment variable, secrets included. Use `printenv NAME` for one harmless variable.` Otherwise `null`.

Allowed examples: `env FOO=1 cmd` (has args), `set -e`, `export FOO=1`, `printenv HOME`, `echo $PATH`, `echo 'uses $TOKEN later'`, PowerShell `$t = Get-Content f; Write-Host $t` (but `Write-Host $token` is denied: `token` is a secret name), and `cat > f <<'EOF'\nuse $TOKEN here\nEOF`.

### Rule 3: chaining

`chainVerdict(tool, command)` returns `null` unless `tool` is `Bash`. Then:

1. `{segs, breaks} = scan(command)`. Return `null` when `breaks` is 0 or no segment is a commit or push.
2. **Commit or push segment:** command word (`commandIndex`) is `git`; scanning the words after it, a `-C` or `-c` skips its value, the first other word not starting with `-` decides, and it counts only if it is `commit` or `push`. (`git -C repo commit` counts; `git status` does not.)
3. **Opt-out:** take the first top-level segment's words (first `top` segment in `segs` order). If its first word is `set` and the second matches `^-[a-zA-Z]*e` (`-e`, `-eu`, `-xe`), or the second is `-o` and the third is `errexit`, return `null`.
4. Otherwise return `Multi-line command with git commit/push: a failing earlier line would not stop it. Start the command with `set -e`, or join every line before the last with `&&`.`

Cases: `git add -A\ngit commit -m x` denied; `cd repo\ngit push` denied; with a leading `set -e` allowed; `git add -A &&\ngit commit -m x` allowed; single-line `git commit -m x` allowed; a commit whose message is a `$(cat <<'EOF' …)` heredoc across lines allowed (zero breaks).

## read-guard.ts

Tool `Bash` only; `readVerdict("PowerShell", …)` is `null`.

### Exports

| Name | Signature |
|---|---|
| `readVerdict` | `(tool: string, command: string, depth = 0) => string \| null` |
| `decide` | `(raw: string) => string \| null` |

`decide`: parse the JSON, call `readVerdict(String(input?.tool_name ?? ""), String(input?.tool_input?.command ?? ""))` (optional chaining, so a missing `tool_input` gives an empty command and `null`, not a throw). Any exception (bad JSON, or one thrown by the rules) returns `null`: this guard fails open, since a non-hook payload has nothing to guard.

### readVerdict

1. Return `null` unless `tool` is `Bash`. Scan the command.
2. **Remote:** if any segment's command word (`base` of `words[commandIndex]`) is `ssh`, return `null` for the whole command.
3. For each segment (`k = commandIndex`, `cmd = base(words[k])`):
   - **Nested shell.** If `cmd` is `bash`, `sh`, `zsh` or `dash`, and `-c` appears in the words after `k`, and a word follows `-c`, and `depth < 4`: recurse on that following word with `depth + 1`. Return its verdict if non-null; either way go to the next segment (the shell itself is never a reader).
   - If `cmd` is not `cat`, `head`, `tail` or `sed`, next segment.
   - `args = words.slice(k + 1)`. Next segment (allow) when any of these holds: `sepAfter` is `|`; stdout is redirected (below); `sed` with an in-place flag (an arg matching `^(-[a-zA-Z]*i|--in-place)`, so `-i`, `-Ei`, `-ri`); `tail` with a follow flag (an arg starting with `-f`, `-F` or `--follow`).
   - Compute the file operands. If there is at least one, deny with `` `<cmd> <first file>` reads a file into the transcript through the shell. Use the Read tool instead (offset and limit for a range); it shows line numbers and respects size limits. ``
4. Otherwise `null`.

**Stdout redirected:** some arg matches `^1?>>?` and does not end in `&2`, or matches `^&>>?`. So `>`, `>>`, `1>f`, `&>/dev/null` count; `2>err` and `>&2` do not.

### File operands

`fileOperands(cmd, args)`, walking the args left to right; the first matching rule wins:

| Arg | Effect |
|---|---|
| `<<<` exactly, or starting with `<<<` | Here-string. Skip it; when it was exactly `<<<`, also skip the next word. |
| starts with `<(` | Process substitution. Skip words until one ends with `)`, starting with this word itself (so `<(x)` alone is skipped). |
| `<` exactly | Input redirect. If a next word exists, it is a file operand and is consumed. (`cat < input.txt` is a read.) |
| starts with a redirect (`^(\d\|&)?>>?`) | Output redirect. Skip it; when the arg is only the operator (`^(\d\|&)?>>?$`), also skip the next word (the target). |
| a value flag for this command | Skip it and the next word. |
| starts with `-` and is not `-` | A flag. Skip. |
| first operand of `sed` when no script flag was given | The sed script. Skip. |
| anything else except `-` | A file operand. |

Value flags: `head`: `-n -c --lines --bytes`. `tail`: `-n -c --lines --bytes -s --sleep-interval --pid`. `sed`: `-e -f --expression --file -l --line-length`. `cat`: none.
Sed's script is pending only when no arg starts with `-e`, `-f`, `--expression` or `--file`.

Consequences: a command with no operand reads stdin and passes (`cat`, `git log | head -5`, `ps aux | tail -n 3`, `head -n1 <<< "$x"`, `cat <(git log)`); `tail -20 log.txt` is denied because `-20` is a flag and `log.txt` is a file; `head -n 50 x.md` is denied because `-n` swallows `50`; `sed -n '1,40p' f` is denied because `1,40p` is the script and `f` is a file.

## Worked examples (each pinned by a test)

| Command | Guard | Result | Why |
|---|---|---|---|
| `gh auth token`, `… --hostname x` | secret | deny | uncaptured, top-level |
| `echo $(gh auth token)`, `echo "t=$(gh auth token)"` | secret | deny | nested, but `echo` prints its arguments |
| `a && gh auth token` | secret | deny | second segment, nothing captures it |
| `gh auth token \| jq .`, `\| cat` | secret | deny | piped to a printer |
| `bash -c 'gh auth token'`, `pwsh -Command "op read x"`, `timeout 5 op read x` | secret | deny | shell recursion, wrapper skipping |
| `TOKEN=$(gh auth token) curl …`, `export T="$(op read x)"`, `$t = gh auth token` (PowerShell) | secret | allow | captured |
| `X=$(curl -H "A: $(gh auth token)" https://example.com)` | secret | allow | nested, and the top-level command is `X=$()` (no command word), not a printer |
| `curl -H "Authorization: Bearer $(gh auth token)" …` | secret | allow | nested inside a non-printer |
| `gh auth token \| docker login … --password-stdin`, `gh auth token > token.txt` | secret | allow | piped to a consumer, redirected |
| `git commit -m "stop running gh auth token"`, `echo 'gh auth token'`, `grep -rn 'op read' .` | secret | allow | the words are inside one quoted word |
| `Read` tool with `gh auth token` | secret | allow | wrong tool |
| `echo -n "$API_KEY"`, `printf "%s" "$DB_PASSWORD"`, `echo "it's" $GITHUB_TOKEN "don't"`, PowerShell `echo $env:OPENAI_API_KEY`, PowerShell `Write-Host $env:GITHUB_TOKEN`, PowerShell `WRITE-HOST $env:github_token`, `echo $token`, `echo $STRIPE_API` | env | deny | printer followed by a reference |
| `echo "$(date) $GITHUB_TOKEN"`, `` echo `date` $GITHUB_TOKEN ``, `echo $(echo $GITHUB_TOKEN)`, `curl -H "$(printf %s "$API_KEY")" x` | env | deny | the reference is outside the substitution, or an inner printer prints it |
| `echo $(foo "(") $GITHUB_TOKEN`, `echo $((1+2)) $GITHUB_TOKEN`, `echo $(($GITHUB_TOKEN))`, `` echo "\`" $GITHUB_TOKEN ``, `echo $(date $GITHUB_TOKEN`, PowerShell `Write-Host "$($env:GITHUB_TOKEN)"` | env | deny | not taken apart, so the whole text is tested |
| `echo $(curl -H "Authorization: Bearer $GITHUB_TOKEN" x)`, `` echo `curl -H "Bearer $GITHUB_TOKEN" x` ``, `echo $(a $(b $(c "$API_KEY")))` | env | allow | the reference is passed to a command inside the substitution |
| `printenv`, `env`, `export -p`, PowerShell `Get-ChildItem env:` | env | deny | unfiltered dump |
| `env \| grep PATH`, `printenv \| wc -l`, `env FOO=1 cmd` | env | allow | filtered or has args |
| `cat < input.txt`, `bash -c 'cat secrets.txt'`, `echo start; cat config.json`, `cd repo && cat README.md` | read | deny | a reader with a file operand in some segment |
| `cat a > b`, `cat a >> b`, `cat f &>/dev/null`, `cat big.md \| grep TODO`, `sed -i …`, `tail -f …`, `ssh host cat …` | read | allow | redirect, pipe, in place, follow, remote |
| `echo cat file.md`, `git commit -m 'cat README.md'` | read | allow | `cat` is not the command word |

## Known limitations

Kept as they are; a rebuild does not need to fix them, and none is tested.

- `SECRET_COMMANDS[cli]` is a plain object lookup, so a command word such as `constructor` finds an inherited member and throws inside `secretVerdict` (`decide` catches it, so the command is denied only if the raw text mentions a secret CLI). A rebuild may use an own-property check instead.
- `cat <file` with no space after `<` is one word `<file`, which `fileOperands` takes as a file name (still denied, but the file name shown in the reason includes the `<`).
- `sudo -u root cmd`: `commandIndex` skips `sudo` and `-u` but not its value, so the command word is `root`.
- Printing through a non-printer inside a substitution is not seen: `echo $(cat <<< "$TOKEN")` passes, because `cat` is not in the printing test's printer list.
- A separator inside a substitution ends the printer's span: `echo $(case x in x) date;; esac) $TOKEN` passes (the stray `)` sends it to the whole-text test, where `;;` stops the span).
- `scan` recurses once per `$(`, so a command nested many thousands deep overflows the stack; `decide` catches it and allows unless the raw text names a secret CLI.
- Strict by design: `REACT_APP_API`, `CACHE_KEY` and `OLD_PWD` are treated as secrets (see `SECRET_ENV`). A false deny costs one rewritten command; a missed secret lands in the transcript.
