// Minimal shell scanner for hook rules (Bash and PowerShell). Splits a command into simple commands
// ("segments") with quotes removed, descends into $( ), ( ) and backticks, skips heredoc bodies, and
// records which top-level newlines are not joined by &&, ||, | or a trailing backslash.
// Not a full parser: it exists so rules can tell a real `gh auth token` from a commit message that mentions it.

export interface Seg {
  words: string[];
  /** Opened by `NAME=$(...)`, `X="$(...)"` or `$x = (...)`: its stdout is captured, not printed. */
  captured: boolean;
  /** Operator that ended this segment: ; && || | & or newline. */
  sepAfter: string;
  top: boolean;
}
export interface Scan {
  segs: Seg[];
  /** Top-level newlines between two statements that are not joined by an operator. */
  breaks: number;
}

// A backslash escapes only these; elsewhere it is a literal (Windows paths).
const ESCAPABLE = new Set(["\\", " ", "\t", "\"", "'", "$", "`", ";", "&", "|", "(", ")", "<", ">", "#", "\n", "\r"]);

export function scan(src: string): Scan {
  let i = 0, breaks = 0;
  const segs: Seg[] = [];

  function body(depth: number, capturedCtx: boolean): void {
    let words: string[] = [];
    let cur: string | null = null;
    let captured = capturedCtx;
    let lastOp = "";
    let lineHasTokens = false, pendingBreak = false;
    const heredocs: { tag: string; strip: boolean }[] = [];

    const endWord = () => { if (cur !== null) { words.push(cur); cur = null; } };
    const endSeg = (op: string) => {
      endWord();
      if (words.length) segs.push({ words, captured, sepAfter: op, top: depth === 0 });
      words = []; captured = capturedCtx;
    };
    const assignPending = () => (cur !== null ? cur.endsWith("=") : words.length > 0 && words[words.length - 1].endsWith("="));
    const token = () => {
      if (depth === 0) { if (pendingBreak) { breaks++; pendingBreak = false; } lineHasTokens = true; lastOp = ""; }
    };
    const sub = (cap: boolean) => { token(); body(depth + 1, cap); cur = (cur ?? "") + "$()"; };

    while (i < src.length) {
      const c = src[i];
      if (c === ")" && depth > 0) { i++; endSeg(")"); return; }
      if (c === "\\") {
        const n = src[i + 1];
        if (n === "\n" || (n === "\r" && src[i + 2] === "\n")) { i += n === "\n" ? 2 : 3; continue; }
        token();
        if (n !== undefined && ESCAPABLE.has(n)) { cur = (cur ?? "") + n; i += 2; } else { cur = (cur ?? "") + c; i++; }
        continue;
      }
      if (c === "'") {
        token();
        const end = src.indexOf("'", i + 1);
        const stop = end < 0 ? src.length : end;
        cur = (cur ?? "") + src.slice(i + 1, stop);
        i = stop + 1;
        continue;
      }
      if (c === '"') {
        token();
        const afterAssign = cur !== null && cur.endsWith("=");
        cur = cur ?? "";
        i++;
        const start = i;
        while (i < src.length && src[i] !== '"') {
          if (src[i] === "\\" && i + 1 < src.length) { cur += src[i + 1]; i += 2; continue; }
          if (src[i] === "$" && src[i + 1] === "(") { i += 2; const cap = afterAssign && i - 2 === start; body(depth + 1, cap); cur += "$()"; continue; }
          if (src[i] === "`") { const e = src.indexOf("`", i + 1); if (e > 0) { const j = i; i = e + 1; const inner = scan(src.slice(j + 1, e)); segs.push(...inner.segs.map((s) => ({ ...s, top: false }))); cur += "$()"; continue; } }
          cur += src[i++];
        }
        i++;
        continue;
      }
      if (c === "`") {
        const e = src.indexOf("`", i + 1);
        if (e < 0) { token(); cur = (cur ?? "") + c; i++; continue; }
        token();
        const cap = assignPending();
        segs.push(...scan(src.slice(i + 1, e)).segs.map((s) => ({ ...s, captured: s.captured || cap, top: false })));
        cur = (cur ?? "") + "$()";
        i = e + 1;
        continue;
      }
      if (c === "$" && src[i + 1] === "(") { const cap = assignPending(); i += 2; sub(cap); continue; }
      if (c === "(" && cur === null) { const cap = assignPending(); i++; sub(cap); continue; }
      if (c === "#" && cur === null) { while (i < src.length && src[i] !== "\n") i++; continue; }
      if (c === " " || c === "\t" || c === "\r") { endWord(); i++; continue; }
      if (c === "\n") {
        i++;
        const idle = words.length === 0 && cur === null;
        if (depth === 0 && !lineHasTokens) { /* blank or comment line */ }
        else if (depth === 0 && !(idle && (lastOp === "&&" || lastOp === "||" || lastOp === "|"))) pendingBreak = true;
        endSeg("\n");
        lineHasTokens = false;
        for (const h of heredocs.splice(0)) {
          while (i < src.length) {
            let e = src.indexOf("\n", i);
            if (e < 0) e = src.length;
            const line = src.slice(i, e).replace(/\r$/, "");
            i = Math.min(e + 1, src.length);
            if ((h.strip ? line.trim() : line) === h.tag) break;
          }
        }
        continue;
      }
      if (c === "<" && src[i + 1] === "<" && src[i + 2] !== "<" && src[i - 1] !== "<") {
        const m = src.slice(i).match(/^<<(-?)\s*(?:'([^']*)'|"([^"]*)"|([^\s;&|()<>]+))/);
        if (m) { heredocs.push({ tag: m[2] ?? m[3] ?? m[4], strip: m[1] === "-" }); i += m[0].length; token(); continue; }
      }
      if (c === ";" || c === "|" || c === "&") {
        // 2>&1, >&2 and &> are redirections, not separators.
        if (c === "&" && (src[i - 1] === ">" || src[i + 1] === ">")) { token(); cur = (cur ?? "") + c; i++; continue; }
        // PowerShell call operator: `& cmd` or `$x = & cmd`.
        if (c === "&" && src[i + 1] !== "&" && cur === null && (words.length === 0 || words[words.length - 1] === "=")) { i++; continue; }
        const op = src.startsWith("&&", i) ? "&&" : src.startsWith("||", i) ? "||" : c;
        i += op.length;
        endSeg(op);
        if (depth === 0) lastOp = op;
        continue;
      }
      token();
      cur = (cur ?? "") + c;
      i++;
    }
    endSeg("");
  }

  body(0, false);
  return { segs, breaks };
}

export const base = (w: string) => (w.split(/[\\/]/).pop() ?? w).replace(/\.(exe|cmd|bat|ps1|ts|js)$/i, "").toLowerCase();

const WRAPPERS = new Set(["env", "command", "exec", "time", "nohup", "timeout", "xargs", "sudo", "nice", "builtin", "{", "!", "call", "start", "export"]);

const KEYWORDS = new Set(["if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done", "case", "esac", "in", "{", "}", "(", ")", "!", "time"]);

/** Index of the first word that is not a shell keyword, `&`, or an env assignment. */
export function firstWordIndex(w: string[]): number {
  // `case x in pat) cmd`: the command starts after the first word ending in `)`.
  let k = w[0] === "case" ? w.findIndex((x) => x.endsWith(")")) + 1 || w.length : 0;
  while (k < w.length && (KEYWORDS.has(w[k]) || w[k] === "&" || /^[A-Za-z_]\w*=/.test(w[k]))) k++;
  return k;
}

/** Index of the real command word, skipping keywords, env assignments, wrappers and their flags. */
export function commandIndex(w: string[]): number {
  let k = firstWordIndex(w);
  while (k < w.length && (KEYWORDS.has(w[k]) || /^[A-Za-z_]\w*=/.test(w[k]) || WRAPPERS.has(base(w[k])) || /^-/.test(w[k]) || /^\d+[smhd]?$/.test(w[k]))) k++;
  return k;
}
