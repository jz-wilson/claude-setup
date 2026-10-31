#!/usr/bin/env bun
// PreToolUse hook for Bash: deny reading a local file into the transcript with cat, head, tail or sed,
// and point the agent at its Read tool, which shows line numbers and reads a range (offset + limit).
// Allowed: output redirected to a file (`cat a > b`), output piped onward (`cat a | grep x`), in-place
// edits (`sed -i`), following a log (`tail -f`), reads on another machine (`ssh host cat f`), and these
// commands reading their stdin (`git log | head -5`).
import { base, commandIndex, scan, type Seg } from "./shell-parse.ts";

const READERS = new Set(["cat", "head", "tail", "sed"]);
// Flags whose next word is their value, not a file.
const VALUE_FLAGS: Record<string, Set<string>> = {
  head: new Set(["-n", "-c", "--lines", "--bytes"]),
  tail: new Set(["-n", "-c", "--lines", "--bytes", "-s", "--sleep-interval", "--pid"]),
  sed: new Set(["-e", "-f", "--expression", "--file", "-l", "--line-length"]),
  cat: new Set(),
};
const REDIRECT = /^(\d|&)?>>?/; // `>`, `>>`, `2>`, or `>file` glued to its target

function fileOperands(cmd: string, args: string[]): string[] {
  const files: string[] = [];
  let scriptPending = cmd === "sed" && !args.some((a) => /^(-e|-f|--expression|--file)/.test(a));
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "<<<" || a.startsWith("<<<")) { if (a === "<<<") i++; continue; } // here-string
    if (a.startsWith("<(")) { while (i < args.length && !args[i].endsWith(")")) i++; continue; } // process substitution
    if (a === "<") { if (args[i + 1]) files.push(args[++i]); continue; } // `cat < f` still prints f
    if (REDIRECT.test(a)) {
      if (/^(\d|&)?>>?$/.test(a)) i++; // the target is the next word
      continue;
    }
    if (VALUE_FLAGS[cmd].has(a)) { i++; continue; }
    if (a.startsWith("-") && a !== "-") continue;
    if (scriptPending) { scriptPending = false; continue; } // sed's first operand is its script
    if (a !== "-") files.push(a);
  }
  return files;
}

function redirectsStdout(args: string[]): boolean {
  return args.some((a) => (/^1?>>?/.test(a) && !a.endsWith("&2")) || /^&>>?/.test(a));
}

const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);

export function readVerdict(tool: string, command: string, depth = 0): string | null {
  if (tool !== "Bash") return null;
  const { segs } = scan(command);
  const remote = segs.some((s) => base(s.words[commandIndex(s.words)] ?? "") === "ssh");
  if (remote) return null;
  for (const seg of segs as Seg[]) {
    const w = seg.words, k = commandIndex(w), cmd = base(w[k] ?? "");
    const c = w.indexOf("-c", k + 1);
    if (SHELLS.has(cmd) && c > 0 && w[c + 1] && depth < 4) {
      const inner = readVerdict(tool, w[c + 1], depth + 1); // bash -c '<script>'
      if (inner) return inner;
      continue;
    }
    if (!READERS.has(cmd)) continue;
    const args = w.slice(k + 1);
    if (seg.sepAfter === "|" || redirectsStdout(args)) continue;
    if (cmd === "sed" && args.some((a) => /^(-[a-zA-Z]*i|--in-place)/.test(a))) continue;
    if (cmd === "tail" && args.some((a) => /^(-f|-F|--follow)/.test(a))) continue;
    const files = fileOperands(cmd, args);
    if (files.length)
      return `\`${cmd} ${files[0]}\` reads a file into the transcript through the shell. ` +
        "Use the Read tool instead (offset and limit for a range); it shows line numbers and respects size limits.";
  }
  return null;
}

export function decide(raw: string): string | null {
  try {
    const input = JSON.parse(raw);
    return readVerdict(String(input?.tool_name ?? ""), String(input?.tool_input?.command ?? ""));
  } catch {
    return null; // not a hook payload: nothing to guard
  }
}

if (import.meta.main) {
  const reason = decide(await Bun.stdin.text());
  if (reason) {
    console.log(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `read-guard: ${reason}` },
    }));
  }
  process.exit(0);
}
