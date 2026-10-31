// PreToolUse hook (matcher: Bash|PowerShell). Three rules, each returning a reason the model can act on:
//  1. Secret CLIs: deny subcommands that print a secret into the transcript, unless stdout is captured
//     into a variable (`TOKEN=$(gh auth token)`). Edit SECRET_COMMANDS for the tools you use.
//  2. Environment: deny printing variables whose names look secret, and unfiltered environment dumps.
//  3. Chaining: a multi-line command with git commit/push must start with `set -e` or join its lines
//     with `&&`, so an earlier failure cannot fall through to the commit.
// Fails closed: if the hook input cannot be parsed and mentions a secret CLI, it denies.
import { base, commandIndex, firstWordIndex, scan, type Seg } from "./shell-parse.ts";

// CLI -> subcommand paths (space-separated) that print secret values.
export const SECRET_COMMANDS: Record<string, string[]> = {
  gh: ["auth token"],
  op: ["read", "item get", "inject"],
  bw: ["get", "list", "export"],
  vault: ["read", "kv get"],
  aws: ["configure get", "secretsmanager get-secret-value"],
  gcloud: ["auth print-access-token", "secrets versions access"],
};
// Upper-case names that end in a secret word: GITHUB_TOKEN, DB_PASSWORD, AWS_SECRET_ACCESS_KEY (not TOKEN_DIR).
const SECRET_ENV = /\b[A-Z0-9_]*(PASSWORD|PASSWD|TOKEN|SECRET|SESSION|API_KEY|PRIVATE_KEY|ACCESS_KEY)\b/;
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "pwsh", "powershell", "cmd", "eval", "iex", "invoke-expression"]);
const HINT = "Pass the value to the command that needs it without printing it, e.g. `TOKEN=$(gh auth token) some-cmd`.";

// Commands that print their arguments or input to the transcript.
const PRINTERS = new Set(["echo", "printf", "print", "cat", "tee", "jq", "head", "tail", "less", "more", "base64", "xxd", "write-host", "write-output"]);

// The subcommand path may follow global flags and their values (`gh --repo a/b auth token`),
// so look for it as a consecutive run anywhere in the non-flag words.
function secretSubcommand(cli: string, args: string[]): string | null {
  const positional = args.filter((a) => !a.startsWith("-"));
  for (const path of SECRET_COMMANDS[cli] ?? []) {
    const parts = path.split(" ");
    for (let s = 0; s + parts.length <= positional.length; s++)
      if (parts.every((p, i) => positional[s + i] === p)) return path;
  }
  return null;
}

function analyze(src: string, out: string[], depth = 0): void {
  const { segs } = scan(src);
  // A secret produced inside $(...) is an argument; it only reaches the transcript when the
  // top-level command is one that prints (`echo $(gh auth token)`).
  const printsArgs = segs.some((s) => s.top && PRINTERS.has(base(s.words[commandIndex(s.words)] ?? "")));
  segs.forEach((seg, idx) => {
    let w = seg.words, captured = seg.captured;
    if (/^\$[\w:.]+$/.test(w[0] ?? "") && w[1] === "=") { w = w.slice(2); captured = true; } // PowerShell `$x = cmd`
    const k = commandIndex(w), cli = base(w[k] ?? "");
    const hit = secretSubcommand(cli, w.slice(k + 1));
    if (hit) {
      const next = segs[idx + 1];
      const pipedTo = seg.sepAfter === "|" && next ? base(next.words[commandIndex(next.words)] ?? "") : "";
      const redirected = w.some((x) => /^\d?>>?[^&]*$/.test(x) && x !== ">&2" && !x.endsWith("&1"));
      const safe = captured || redirected || (pipedTo !== "" && !PRINTERS.has(pipedTo)) || (!seg.top && !printsArgs);
      if (!safe) out.push(`\`${cli} ${hit}\` prints a secret into the transcript. ${HINT}`);
    } else if (SHELLS.has(cli) && depth < 4) analyze(w.slice(k + 1).filter((x) => !/^(-\w+|\/c)$/i.test(x)).join(" "), out, depth + 1);
  });
}

export function secretVerdict(tool: string, command: string): string | null {
  if (tool !== "Bash" && tool !== "PowerShell") return null;
  const found: string[] = [];
  analyze(command, found);
  return found[0] ?? null;
}

// Remove single-quoted text (literal in sh), but only outside double quotes, where `'` is just an apostrophe.
function stripSingleQuoted(s: string): string {
  let out = "", inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' && s[i - 1] !== "\\") inDouble = !inDouble;
    if (c === "'" && !inDouble) { const e = s.indexOf("'", i + 1); if (e > 0) { out += " "; i = e; continue; } }
    out += c;
  }
  return out;
}

const LISTERS = new Set(["get-childitem", "gci", "ls", "dir", "get-item", "gi"]);

export function envVerdict(tool: string, command: string): string | null {
  if (tool !== "Bash" && tool !== "PowerShell") return null;
  const text = stripSingleQuoted(command.replace(/<<-?\s*(['"])(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\n|$)/g, " ")); // quoted heredoc bodies are literal
  const S = SECRET_ENV.source;
  const ref = String.raw`(\$\{?${S}|\$env:${S}|%${S}%)`;
  // Passing a secret to a command (`curl -H "Bearer $TOKEN"`) is fine; printing it is not.
  // PowerShell cmdlet names are case-insensitive, so Write-Host/Write-Output match in any case;
  // the rest of the pattern stays case-sensitive (secret env names are upper-case).
  const printing = new RegExp(String.raw`\b(echo|printf|print|[Ww][Rr][Ii][Tt][Ee]-(?:[Hh][Oo][Ss][Tt]|[Oo][Uu][Tt][Pp][Uu][Tt]))\b[^;&|\n]*${ref}|\bprintenv\s+${S}|(^|[;&|\n]\s*)\$env:${S}\s*($|[;&|\n])`, "m");
  if (printing.test(text)) {
    return "This prints a secret-looking environment variable. Test it with `[ -n \"$NAME\" ]` or pass it to the command that needs it.";
  }
  for (const seg of scan(command).segs) {
    const w = seg.words, k = firstWordIndex(w), cmd = base(w[k] ?? ""), args = w.slice(k + 1);
    if (seg.sepAfter === "|") continue; // `env | grep PATH` is filtered
    const dump =
      ((cmd === "printenv" || cmd === "env" || cmd === "set") && args.length === 0) ||
      (cmd === "export" && (args.length === 0 || args[0] === "-p")) ||
      (LISTERS.has(cmd) && args.length === 1 && /^env:[\\/]?\*?$/i.test(args[0]));
    if (dump) return `${cmd} with no filter dumps every environment variable, secrets included. Use \`printenv NAME\` for one harmless variable.`;
  }
  return null;
}

function isCommitOrPush(seg: Seg): boolean {
  const w = seg.words, k = commandIndex(w);
  if (base(w[k] ?? "") !== "git") return false;
  for (let j = k + 1; j < w.length; j++) {
    if (w[j] === "-C" || w[j] === "-c") j++;
    else if (!w[j].startsWith("-")) return w[j] === "commit" || w[j] === "push";
  }
  return false;
}

export function chainVerdict(tool: string, command: string): string | null {
  if (tool !== "Bash") return null;
  const { segs, breaks } = scan(command);
  if (!breaks || !segs.some(isCommitOrPush)) return null;
  const first = segs.find((s) => s.top)?.words ?? [];
  if (base(first[0] ?? "") === "set" && (/^-[a-zA-Z]*e/.test(first[1] ?? "") || (first[1] === "-o" && first[2] === "errexit"))) return null;
  return "Multi-line command with git commit/push: a failing earlier line would not stop it. " +
    "Start the command with `set -e`, or join every line before the last with `&&`.";
}

export const evaluate = (tool: string, command: string) =>
  secretVerdict(tool, command) ?? envVerdict(tool, command) ?? chainVerdict(tool, command);

const MENTIONS_SECRET_CLI = new RegExp(String.raw`\b(${Object.keys(SECRET_COMMANDS).join("|")})\b`);

export function decide(raw: string): string | null {
  try {
    const input = JSON.parse(raw);
    return evaluate(String(input?.tool_name ?? ""), String(input?.tool_input?.command ?? ""));
  } catch {
    return MENTIONS_SECRET_CLI.test(raw) ? "could not parse a command that mentions a secret CLI, so it is denied." : null;
  }
}

if (import.meta.main) {
  const reason = decide(await Bun.stdin.text());
  if (reason) {
    console.log(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `shell-guard: ${reason}` },
    }));
  }
  process.exit(0);
}
