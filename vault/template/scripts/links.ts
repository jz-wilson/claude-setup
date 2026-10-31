// Standard Markdown links are the vault's only link syntax. This module is the one place
// that knows the rules, shared by the validators, the generators and move-note:
//
//   - A vault-internal link is `[text](relative/path.md)` — the path is relative to the
//     directory of the file the link sits in, POSIX slashes, extension included, `../` to
//     climb. No bare stems, no vault-root-absolute paths, no basename fallback: the path
//     names one file, case-sensitively, the way every Markdown renderer resolves it.
//   - `[text](relative/path.md#heading)` links a heading; the anchor is the GitHub slug.
//   - Attachments link the same way: `[report.pdf](../personal/report.pdf)`.
//   - External links (`https://…`, `mailto:`), pure anchors (`#section`) and images
//     (`![alt](…)`) are not vault links and are ignored by every scanner here.
//   - Links inside fenced code blocks and inline code are text, not links.
//
// Typed edges in frontmatter name their target as a canonical id: `target: projects/x`
// (vault-relative, no `.md`, no brackets). See `extractEdges` in frontmatter.ts.
import { dirname, posix } from "node:path";

export interface MdLink {
  /** The visible text between the brackets. */
  text: string;
  /** The destination as written (title and angle brackets stripped). */
  href: string;
  /** 1-based line of the link in the text it was extracted from. */
  line: number;
  /** Character offset of the `[` in the source text. */
  index: number;
  /** The whole `[text](href)` as written, for replacements. */
  raw: string;
}

/** `[[…]]`, kept only so the validator can name the retired syntax and the migration can
 *  find it. Groups: 1 target (possibly empty, for a same-note `[[#Heading]]` link), 2 heading
 *  (after `#`), 3 alias (after `|` or, as Obsidian writes it inside a table cell, `\|`). The
 *  target group stops before an escaped `\|` (a lookahead-guarded backslash) so `[[x\|alias]]`
 *  yields target `x`, not `x\`; the alias group then accepts the optional leading backslash. */
export const WIKI_LINK_RE = /\[\[((?:[^\]|#\\]|\\(?!\|))*)(?:#([^\]|]*))?(?:\\?\|([^\]]*))?\]\]/g;

// `[text](href)` with balanced single-level brackets in the text, an optional "title", and
// optional <angle brackets> around the href. Not preceded by `!` (an image) or `]` (a
// reference-style link's second bracket pair).
const MD_LINK_RE = /(?<![!\]])\[((?:\\.|[^\[\]\\]|\[[^\[\]]*\])*)\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;

/** The text with fenced code blocks and inline code replaced by spaces of the same length,
 *  so offsets and line numbers survive and nothing inside code is ever read as a link. */
export function blankCode(text: string): string {
  let out = "";
  let inFence: string | null = null;
  for (const rawLine of text.split(/(?<=\n)/)) {
    const line = rawLine.replace(/\r?\n$/, "");
    const nl = rawLine.slice(line.length);
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (inFence) {
      if (fence && fence[1][0] === inFence[0] && fence[1].length >= inFence.length) inFence = null;
      out += " ".repeat(line.length) + nl;
      continue;
    }
    if (fence) {
      inFence = fence[1];
      out += " ".repeat(line.length) + nl;
      continue;
    }
    out += line.replace(/`+[^`]*`+/g, (m) => " ".repeat(m.length)) + nl;
  }
  return out;
}

/** `true` for anything that is not a path inside the vault: a URL, a mail link, a protocol-
 *  relative URL, or a bare anchor. */
export function isExternal(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("#") || href === "";
}

/** Split `path#anchor` into its parts; the anchor comes back without the `#`. */
export function splitHref(href: string): { path: string; anchor: string | null } {
  const i = href.indexOf("#");
  return i === -1 ? { path: href, anchor: null } : { path: href.slice(0, i), anchor: href.slice(i + 1) };
}

/** Binary-search line lookup shared by every scanner that walks a blob of text collecting
 *  character offsets and needs to turn each one into a 1-based line number: `extractLinks`
 *  here, `checkRetiredWikiLinks` (frontmatter.ts).
 *  Built once per text; `lineOf(idx)` is then O(log n). */
export function lineIndex(text: string): { lineOf(idx: number): number } {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (idx: number): number => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  return { lineOf };
}

/** Reverse of the escaping `mdLink`/`escapeLinkText` apply to link text: `\\` -> `\`, `\[` -> `[`,
 *  `\]` -> `]`. Single left-to-right pass, so an already-resolved escape is never re-processed. */
function unescapeLinkText(text: string): string {
  return text.replace(/\\([\\[\]])/g, "$1");
}

/** Every Markdown link in `text` outside code, in document order. External links and bare
 *  anchors are included; callers filter with `isExternal` when they want vault links only.
 *  `text` is returned unescaped (the reverse of `escapeLinkText`), so callers see the link
 *  text as a person would read it, not the `\[`/`\]`/`\\`-escaped form written on disk. */
export function extractLinks(text: string): MdLink[] {
  const scan = blankCode(text);
  const out: MdLink[] = [];
  const { lineOf } = lineIndex(scan);
  for (const m of scan.matchAll(MD_LINK_RE)) {
    let href = m[2];
    if (href.startsWith("<") && href.endsWith(">")) href = href.slice(1, -1);
    // `%20` and friends are how a renderer sees a space; decode so the path matches the file.
    try { href = decodeURI(href); } catch {}
    const index = m.index ?? 0;
    out.push({ text: unescapeLinkText(m[1]), href, line: lineOf(index), index, raw: text.slice(index, index + m[0].length) });
  }
  return out;
}

/** Vault-internal links only: the ones whose href is a path, with the anchor split off. */
export function vaultLinks(text: string): (MdLink & { path: string; anchor: string | null })[] {
  return extractLinks(text)
    .filter((l) => !isExternal(l.href))
    .map((l) => ({ ...l, ...splitHref(l.href) }));
}

/** Normalise a POSIX path: collapse `.`/`..`, no leading `./`. Returns null if it climbs
 *  above the root (starts with `..` after normalisation) — a link that escapes the vault. */
function normalise(p: string): string | null {
  const n = posix.normalize(p).replace(/^\.\//, "");
  if (n === ".." || n.startsWith("../") || posix.isAbsolute(n)) return null;
  return n === "." ? "" : n;
}

/** The vault-relative path (forward slashes, extension as written) a link points at, given
 *  the vault-relative path of the file that carries it. Null for external links, bare
 *  anchors, absolute paths, and paths that climb out of the vault. */
export function resolveHref(fromRel: string, href: string): string | null {
  if (isExternal(href)) return null;
  const { path } = splitHref(href);
  if (!path || path.startsWith("/")) return null;
  const dir = dirname(fromRel.replaceAll("\\", "/"));
  return normalise(posix.join(dir === "." ? "" : dir, path));
}

/** The href to write in `fromRel` so that it points at `targetRel` (both vault-relative,
 *  forward slashes, extension included). Same directory yields the bare file name. */
export function hrefFor(fromRel: string, targetRel: string): string {
  const from = dirname(fromRel.replaceAll("\\", "/"));
  const rel = posix.relative(from === "." ? "" : from, targetRel.replaceAll("\\", "/"));
  return rel || posix.basename(targetRel);
}

/** Canonical note id: vault-relative path without `.md`. */
export const canonicalId = (rel: string) => rel.replaceAll("\\", "/").replace(/\.md$/i, "");

/** GitHub-style heading slug: lowercase; drop every character that is not a Unicode letter,
 *  number, space, hyphen, or underscore; turn each individual space into a hyphen (runs are
 *  NOT collapsed — `"a  b"` -> `"a--b"`, matching github.com's own slugger, not a generic
 *  kebab-case). */
export function slugAnchor(heading: string): string {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
}

/** Escape link text for embedding in `[text](href)`: `\`, `[` and `]` always (so a title like
 *  `C:\` or `Notes [draft` round-trips through `extractLinks`), and `|` too when `escapePipe`
 *  is set — the vault-note migration passes it for a link that sits inside a Markdown table
 *  row, where a raw `|` would otherwise split the cell. */
export function escapeLinkText(text: string, escapePipe = false): string {
  const t = text.replace(/[\\[\]]/g, (c) => `\\${c}`);
  return escapePipe ? t.replace(/\|/g, "\\|") : t;
}

/** One Markdown link, written the vault way: text escaped for link syntax (see
 *  `escapeLinkText`), href relative to `fromRel`. */
export function mdLink(text: string, fromRel: string, targetRel: string, anchor?: string | null, escapePipe = false): string {
  const href = hrefFor(fromRel, targetRel) + (anchor ? `#${anchor}` : "");
  return `[${escapeLinkText(text, escapePipe)}](${/[\s()]/.test(href) ? `<${href}>` : href})`;
}
