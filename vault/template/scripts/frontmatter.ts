// Shared frontmatter parsing primitives.
// Operates on arrays of lines WITHOUT trailing newline chars.
import { readFileSync } from "node:fs";
import { blankCode, lineIndex, WIKI_LINK_RE } from "./links.ts";

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_URL_RE = /file:\/\//;
const UNIX_PATH_RE = /(?:^|[\s"'(])\/(?:mnt|Users|home|root|var|etc|opt)\//;
const WIN_PATH_RE = /(?:^|[\s"'(])[A-Za-z]:[/\\]|\\\\[\w.-]+\\/;
export const INLINE_CODE_RE = /`[^`]*`/g;
// CommonMark allows a fence indented up to 3 spaces (4+ is a code block, not a fence).
export const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

export interface ParsedFm {
  fm: string[]; // frontmatter lines (between the --- delimiters)
  body: string[]; // body lines (after closing ---)
  closeLineNo: number; // 1-based file line of the closing ---
}

/** Split text into lines without newline chars, mirroring Python splitlines() (handles CRLF).
 *  Also strips a leading UTF-8 BOM (U+FEFF) if present — PowerShell's `Out-File`/`>`/`>>`
 *  default to UTF-8-with-BOM on Windows, and a BOM-prefixed "﻿---" line otherwise fails the
 *  `lines[0] === "---"` check in parseFrontmatter(), silently dropping the whole note's
 *  frontmatter (type/updated/tags all null, sections empty, no error surfaced). */
export function splitLines(text: string): string[] {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = stripped.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** True if `val` (already DATE_RE-matched) is a real calendar date, not a JS-normalized overflow (e.g. 2026-02-30). */
export function isValidCalendarDate(val: string): boolean {
  const [y, m, day] = val.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, day));
  return d.getUTCFullYear() === y && d.getUTCMonth() === m - 1 && d.getUTCDate() === day;
}

export function parseFrontmatter(lines: string[]): ParsedFm | null {
  if (lines.length === 0 || lines[0] !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      return { fm: lines.slice(1, i), body: lines.slice(i + 1), closeLineNo: i + 1 };
    }
  }
  return null;
}

export function extractField(fm: string[], field: string): string | null {
  const prefix = field + ":";
  for (const line of fm) {
    const s = line.trim();
    if (s.startsWith(prefix)) {
      let val = s.slice(prefix.length).trim();
      const quotedThenComment = val.match(/^("[^"]*"|'[^']*')\s+#.*$/);
      if (quotedThenComment) val = quotedThenComment[1];
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      } else {
        val = val.replace(/\s+#.*$/, ""); // inline YAML comment on an unquoted value
      }
      return val;
    }
  }
  return null;
}

// notFound defaults to fmStart so validators can point an error at the top of the
// frontmatter block; a caller that overwrites the returned line must pass a sentinel
// (e.g. -1) to tell "field absent" apart from "field on the first line".
export function fmLineNo(fm: string[], field: string, fmStart = 2, notFound = fmStart): number {
  const prefix = field + ":";
  for (let i = 0; i < fm.length; i++) {
    if (fm[i].trim().startsWith(prefix)) return fmStart + i;
  }
  return notFound;
}

/** Extract tags list, handling inline [a, b] and block (- a) forms. null if absent. */
export function extractTagsList(fm: string[]): string[] | null {
  const prefix = "tags:";
  for (let i = 0; i < fm.length; i++) {
    const stripped = fm[i].trim();
    if (!stripped.startsWith(prefix)) continue;
    const inlineVal = stripped.slice(prefix.length).trim();
    if (inlineVal) {
      // Any bracket present means an inline-array form — parse it leniently even if a
      // bracket is missing (`[a, b`), so a malformed line yields its intended tags
      // instead of one garbage tag that slips past validation. Only a truly
      // bracket-less value is a bare single tag.
      const bare = inlineVal.replace(/\s+#.*$/, "");
      if (bare.startsWith("[") || bare.endsWith("]")) {
        const inner = bare.replace(/^\[/, "").replace(/\]$/, "");
        return inner
          .split(",")
          .map((t) => t.trim().replace(/^['"]|['"]$/g, ""))
          .filter((t) => t.length > 0);
      }
      return [inlineVal];
    }
    // block list form
    const tags: string[] = [];
    for (let j = i + 1; j < fm.length; j++) {
      const sub = fm[j].trim();
      if (sub.startsWith("- ")) tags.push(sub.slice(2).trim());
      else if (sub === "" || sub.includes(":")) break;
    }
    return tags.length ? tags : null;
  }
  return null;
}

/** Every top-level frontmatter key that carries a list value (inline `[a, b]` or a YAML block
 *  list of `  - item` lines), keyed by field name, values in file order. Generalizes
 *  extractTagsList()'s inline/block parsing to any key, so metrics/validators can read
 *  `commits:`, `tags:`, `edges:` (and any future list field) uniformly without hand-rolling
 *  the same inline-vs-block detection per caller. A scalar-valued key (no brackets, no `- `
 *  continuation) is simply absent from the returned map, not present with a single-item list.
 *
 *  For a block list of mappings (e.g. `edges:`, whose entries are `- type: ..., target: ...`
 *  spread across several indented lines), each returned item is only that entry's first line
 *  with its `- ` marker stripped (e.g. `'type: relates-to'`) — this is a uniform, lossless-enough
 *  index for existence/count checks and substring scans; a caller that needs the full parsed
 *  edge (type/target/context/temporal stamps) should use extractEdges() instead. */
export function extractFmLists(fm: string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (let i = 0; i < fm.length; i++) {
    const raw = fm[i];
    if (raw !== raw.trimStart()) continue; // indented line: a continuation, handled below
    const m = /^([A-Za-z_][\w-]*):(.*)$/.exec(raw);
    if (!m) continue;
    const key = m[1];
    const inlineVal = m[2].trim().replace(/(\])\s+#.*$/, "$1"); // `[a, b]  # comment`
    if (inlineVal) {
      if (inlineVal.startsWith("[") || inlineVal.endsWith("]")) {
        const inner = inlineVal.replace(/^\[/, "").replace(/\]$/, "");
        const items = inner
          .split(",")
          .map((t) => t.trim().replace(/^['"]|['"]$/g, ""))
          .filter((t) => t.length > 0);
        if (items.length) result.set(key, items);
      }
      continue; // bracket-less inline value is a scalar, not a list
    }
    // Block list form: following indented lines until the next column-0 key.
    const items: string[] = [];
    for (let j = i + 1; j < fm.length; j++) {
      const sub = fm[j];
      const trimmed = sub.trim();
      if (trimmed === "") continue;
      const indented = sub.length !== sub.trimStart().length;
      if (!indented) break;
      if (trimmed.startsWith("- ")) items.push(trimmed.slice(2).trim());
    }
    if (items.length) result.set(key, items);
  }
  return result;
}

export type LineError = [number, string];

// ---------------------------------------------------------------------------
// Typed edges (an optional `edges:` frontmatter list). The hand-rolled extractField/extractTagsList
// pair above is line-based and cannot express a nested list-of-objects, so the `edges:`
// block is the one field parsed with real YAML. Bun.YAML ships with Bun >=1.3, so this
// stays dependency-free — package.json has no dependencies and that discipline holds.
// ---------------------------------------------------------------------------

/** Matches a retired `[[wiki-link]]` edge target, so extractEdges can name that one violation
 *  with its own, more actionable message instead of falling through to a generic "bad id". */
const EDGE_TARGET_RE = /^\[\[/;

export interface Edge {
  type: string;
  target: string; // canonical vault-relative id, no `.md`, e.g. "infrastructure/nodes"
  link: string; // same as target — kept as a separate field for callers written against the
  // pre-migration shape, where `link` was the wiki-link's target text with alias/heading stripped
  context: string;
  line: number; // 1-based file line of this entry's `- ` marker
  // Bi-temporal stamping, edge-scoped and optional. `valid_at` is when the relationship began
  // holding in the world; `invalid_at` when it stopped. `recorded_at` is deliberately absent —
  // git already records when the edge was written, and duplicating it would be a second source
  // of truth. An invalidated edge is retained, never deleted: belief revision, not amnesia.
  valid_at?: string;
  invalid_at?: string;
}

const TEMPORAL_KEYS = ["valid_at", "invalid_at"] as const;

/** File line numbers of each `- ` entry inside the `edges:` block, in document order, so an
 *  error can point at the offending entry instead of the top of the frontmatter. YAML permits
 *  a sequence at the parent's indentation, so a column-0 `- ` still belongs to the block; only
 *  a column-0 line that is NOT a list item starts the next top-level key. */
function edgeEntryLines(fm: string[], fmStart: number, edgesIdx: number): number[] {
  const lines: number[] = [];
  for (let j = edgesIdx + 1; j < fm.length; j++) {
    const raw = fm[j];
    const s = raw.trim();
    if (s === "") continue;
    const indented = raw.length !== raw.trimStart().length;
    if (!indented && !s.startsWith("- ")) break;
    if (s.startsWith("- ")) lines.push(fmStart + j);
  }
  return lines;
}

/** Index of the top-level `edges:` key in a frontmatter block, or -1. Deliberately anchored at
 *  column 0 (unlike extractField's trim-then-match) — `edges:` is a top-level key by spec, and
 *  matching an indented one would misread a nested mapping as the block. */
function edgesKeyIndex(fm: string[]): number {
  return fm.findIndex((l) => /^edges:/.test(l));
}

/** Validates edges[i].target against the canonical-id rules (Typed
 *  edges): vault-relative, no `.md`, no leading `/`, no `../`, no `#` anchor, no `|` alias.
 *  Checked in this order so the first violation found gets a specific, actionable message
 *  instead of a generic "malformed id" — the retired wiki-link form is checked first since
 *  it is the most common leftover from the old syntax and deserves its own wording. Returns
 *  null when `t` (already trimmed) is a valid canonical id. */
function edgeTargetError(t: string, i: number): string | null {
  if (EDGE_TARGET_RE.test(t))
    return `edges[${i}].target uses the retired [[wiki-link]] syntax; write the canonical id (e.g. target: projects/example)`;
  if (t === "")
    return `edges[${i}].target must be a non-empty canonical id`;
  if (t.endsWith(".md") || /\.md[/#]/.test(t))
    return `edges[${i}].target must not include the '.md' extension; write the canonical id (e.g. target: projects/example), got: '${t}'`;
  if (t.startsWith("/"))
    return `edges[${i}].target must be vault-relative, not an absolute path, got: '${t}'`;
  if (t.includes("../"))
    return `edges[${i}].target must not climb out of the vault with '../', got: '${t}'`;
  if (t.includes("#"))
    return `edges[${i}].target must not include a '#' heading anchor, got: '${t}'`;
  if (t.includes("|"))
    return `edges[${i}].target must not include a '|' alias, got: '${t}'`;
  return null;
}

/** Parse the `edges:` block. Structural validation only — the `type` vocabulary is checked by
 *  validateEdges(), which needs config. Callers that only want the data (checkLinks)
 *  use this directly and ignore `errors`.
 *
 *  Graceful degradation is load-bearing: a note with no `edges:` key returns `{[], []}` without
 *  ever reaching the YAML parser, so notes that don't opt in are validated byte-for-byte
 *  as they were before typed edges existed. The validators run from blocking hooks, so a
 *  regression here would block every vault write. */
export function extractEdges(fm: string[], fmStart = 2): { edges: Edge[]; errors: LineError[] } {
  const edges: Edge[] = [];
  const errors: LineError[] = [];

  const edgesIdx = edgesKeyIndex(fm);
  if (edgesIdx < 0) return { edges, errors };
  const blockLine = fmStart + edgesIdx;

  let doc: unknown;
  try {
    doc = Bun.YAML.parse(fm.join("\n"));
  } catch (e: unknown) {
    const msg = String((e as Error)?.message ?? e).split("\n")[0];
    errors.push([blockLine, `frontmatter declares 'edges:' but is not valid YAML: ${msg}`]);
    return { edges, errors };
  }

  const rawEdges = (doc as Record<string, unknown> | null)?.edges;
  if (rawEdges === null || rawEdges === undefined) {
    errors.push([blockLine, "'edges:' is present but empty — omit the key entirely when a note has no structural relationships"]);
    return { edges, errors };
  }
  if (!Array.isArray(rawEdges)) {
    errors.push([blockLine, `'edges:' must be a YAML list of entries, got ${typeof rawEdges}`]);
    return { edges, errors };
  }
  if (rawEdges.length === 0) {
    errors.push([blockLine, "'edges:' is an empty list — omit the key entirely when a note has no structural relationships"]);
    return { edges, errors };
  }

  const entryLines = edgeEntryLines(fm, fmStart, edgesIdx);
  for (let i = 0; i < rawEdges.length; i++) {
    const ln = entryLines[i] ?? blockLine;
    const entry = rawEdges[i];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push([ln, `edges[${i}] must be a mapping with 'type', 'target' and 'context' keys`]);
      continue;
    }
    const rec = entry as Record<string, unknown>;

    let ok = true;
    for (const key of ["type", "target", "context"]) {
      if (!(key in rec)) {
        errors.push([ln, `edges[${i}] is missing required key '${key}'`]);
        ok = false;
      }
    }

    if ("target" in rec && typeof rec.target !== "string") {
      errors.push([ln, `edges[${i}] 'target' must be a string canonical id, e.g. target: projects/example, got: ${typeof rec.target}`]);
      ok = false;
    } else if (typeof rec.target === "string") {
      const err = edgeTargetError(rec.target.trim(), i);
      if (err) {
        errors.push([ln, err]);
        ok = false;
      }
    }

    for (const key of ["type", "context"]) {
      const val = rec[key];
      if (key in rec && (typeof val !== "string" || val.trim() === "")) {
        errors.push([ln, `edges[${i}] '${key}' must be a non-empty string`]);
        ok = false;
      }
    }
    // Optional bi-temporal stamps. YAML auto-parses an unquoted date into a Date object, so
    // accept either that or a string and normalise to YYYY-MM-DD before checking.
    const temporal: { valid_at?: string; invalid_at?: string } = {};
    for (const key of TEMPORAL_KEYS) {
      if (!(key in rec)) continue;
      const val = rec[key];
      const str = val instanceof Date ? val.toISOString().slice(0, 10) : String(val);
      if (!DATE_RE.test(str) || !isValidCalendarDate(str)) {
        errors.push([ln, `edges[${i}] '${key}' must be a real calendar date as YYYY-MM-DD, got: '${str}'`]);
        ok = false;
        continue;
      }
      temporal[key] = str;
    }
    if (temporal.valid_at && temporal.invalid_at && temporal.invalid_at < temporal.valid_at) {
      errors.push([ln, `edges[${i}] 'invalid_at' (${temporal.invalid_at}) precedes 'valid_at' (${temporal.valid_at})`]);
      ok = false;
    }
    if (!ok) continue;

    const target = (rec.target as string).trim();
    edges.push({
      type: (rec.type as string).trim(),
      target,
      link: target,
      context: (rec.context as string).trim(),
      line: ln,
      ...temporal,
    });
  }

  return { edges, errors };
}

const sortedEdgeTypes = (s: Set<string>) => "[" + [...s].sort().map((t) => `'${t}'`).join(", ") + "]";

/** Full edge validation: structure (extractEdges) plus the closed `type` vocabulary.
 *  Called from BOTH validators — agent-logs route through validate-logs.ts and never reach
 *  validate-vault.ts's per-note path, so a single call site would leave `evidence-for` edges,
 *  which only ever originate on agent-logs, entirely unchecked. */
export function validateEdges(fm: string[], fmStart: number, edgeTypes: Set<string>): LineError[] {
  const { edges, errors } = extractEdges(fm, fmStart);
  for (const e of edges) {
    if (!edgeTypes.has(e.type))
      errors.push([e.line, `edge 'type' must be one of ${sortedEdgeTypes(edgeTypes)}, got: '${e.type}' — add it to 'edge_types' in vault.config.json before using it`]);
  }
  return errors;
}

export interface NoteShape {
  fm: string[];
  body: string[];
  closeLineNo: number;
  fmStart: number;
}

/** Readable/trailing-newline/frontmatter-delimiter check shared by validate-logs.ts and
 *  validate-vault.ts. `shape` is null when a fatal shape error means parsing can't continue —
 *  `errors` is always populated in that case. `preread` lets a full-vault scan pass text it
 *  has already read instead of reading the file again. */
export function validateCommonNoteShape(path: string, preread?: string): { errors: LineError[]; shape: NoteShape | null } {
  const errors: LineError[] = [];
  let text: string;
  if (preread !== undefined) {
    text = preread;
  } else {
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      errors.push([1, `cannot read file: ${e}`]);
      return { errors, shape: null };
    }
  }

  if (!text.endsWith("\n")) errors.push([0, "file does not end with a newline"]);
  else if (text.endsWith("\n\n")) errors.push([0, "file has trailing blank lines (must end with exactly one newline)"]);

  const nlines = splitLines(text);
  if (nlines.length === 0 || nlines[0] !== "---") {
    errors.push([1, "file does not start with '---' frontmatter delimiter"]);
    return { errors, shape: null };
  }

  const parsed = parseFrontmatter(nlines);
  if (parsed === null) {
    errors.push([1, "frontmatter opening '---' has no matching closing '---'"]);
    return { errors, shape: null };
  }
  return { errors, shape: { fm: parsed.fm, body: parsed.body, closeLineNo: parsed.closeLineNo, fmStart: 2 } };
}

export function checkBodyPaths(body: string[], startLineNo: number): LineError[] {
  const errors: LineError[] = [];
  let inFence = false;
  for (let i = 0; i < body.length; i++) {
    const line = body[i];
    const lineno = startLineNo + i;
    if (FENCE_RE.test(line)) inFence = !inFence;
    if (inFence) continue;
    const check = line.replace(INLINE_CODE_RE, "");
    if (FILE_URL_RE.test(check)) errors.push([lineno, "body contains forbidden 'file://' URL"]);
    if (UNIX_PATH_RE.test(check))
      errors.push([lineno, "body contains an absolute Unix path (use a relative Markdown link instead)"]);
    if (WIN_PATH_RE.test(check))
      errors.push([lineno, "body contains an absolute Windows or UNC path (use a relative Markdown link instead)"]);
  }
  return errors;
}

/** Retired `[[wiki-link]]` syntax found in a note body outside code (fenced code blocks and
 *  inline code are blanked via `blankCode`, same as every other scanner in links.ts). One
 *  error per match, at the file line it appears on. Shared by validate-vault.ts (ordinary
 *  notes) and validate-logs.ts (agent logs) so both retire the syntax with the same message. */
export function checkRetiredWikiLinks(body: string[], startLineNo: number): LineError[] {
  const errors: LineError[] = [];
  const text = blankCode(body.join("\n"));
  const { lineOf } = lineIndex(text);
  for (const m of text.matchAll(WIKI_LINK_RE))
    errors.push([startLineNo + lineOf(m.index ?? 0) - 1, "wiki-link syntax is not supported; write [text](relative/path.md)"]);
  return errors;
}

/** Body headings outside code fences, with their 0-based body index. */
export function bodyHeadings(body: string[]): { level: number; title: string; idx: number }[] {
  const out: { level: number; title: string; idx: number }[] = [];
  let inFence = false;
  body.forEach((line, idx) => {
    if (FENCE_RE.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    const m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m) out.push({ level: m[1].length, title: m[2], idx });
  });
  return out;
}

/** Exactly one H1, and the H2 sections Summary, Notes, Related present in that order. */
export function checkHeadings(body: string[], startLineNo: number): LineError[] {
  const errors: LineError[] = [];
  const hs = bodyHeadings(body);
  const h1 = hs.filter((h) => h.level === 1).length;
  if (h1 !== 1) errors.push([startLineNo, `body needs exactly one H1 heading, found ${h1}`]);
  const order = hs.filter((h) => h.level === 2 && ["Summary", "Notes", "Related"].includes(h.title)).map((h) => h.title);
  for (const want of ["Summary", "Notes", "Related"]) {
    const n = order.filter((t) => t === want).length;
    if (n === 0) errors.push([startLineNo, `body missing required section '## ${want}'`]);
    if (n > 1) errors.push([startLineNo, `section '## ${want}' appears ${n} times; keep one`]);
  }
  if (order.length === 3 && order.join() !== "Summary,Notes,Related")
    errors.push([startLineNo, "sections must be ## Summary, ## Notes, ## Related, in that order"]);
  return errors;
}

/** Read and parse a note's frontmatter; null when the file is unreadable or has none. */
export function readFrontmatterFile(path: string): ParsedFm | null {
  try {
    return parseFrontmatter(splitLines(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}
