#!/usr/bin/env bun
// Append a dated fact to a vault note and bump updated:.
//   capture.ts --type project --note vkit "v0.3.1 adds folder routing"
//   capture.ts --type decision "decided to defer Phase 4"   (episodic -> monthly file)
// semantic types -> <dir>/<note>.md (--note required)
// episodic types -> <dir>/<YYYY-MM>.md (--note ignored)
import { consola, pc } from "./cli-colors.ts";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { relative, resolve, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { parseFrontmatter, fmLineNo, splitLines } from "./frontmatter.ts";
import { loadFromScript, runMain, toPosix, type Derived } from "./config.ts";
import { validateVaultNote } from "./validate-vault.ts";

export function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function ym(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
const titleCase = (s: string) =>
  s.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export function resolvePath(d: Derived, vaultRoot: string, noteType: string, noteName: string, today: Date): string {
  if (noteType in d.EPISODIC_DIRS) return join(vaultRoot, d.EPISODIC_DIRS[noteType], `${ym(today)}.md`);
  if (noteType in d.SEMANTIC_DIRS) {
    if (!noteName || /[\/\\]/.test(noteName) || noteName === "." || noteName === "..")
      throw new Error(`invalid --note '${noteName}': must be a plain filename with no path separators`);
    return join(vaultRoot, d.SEMANTIC_DIRS[noteType], `${noteName}.md`);
  }
  throw new Error(`unsupported type '${noteType}' (choices: ${Object.keys(d.TYPE_DIRS).join(", ")})`);
}

function titleFor(d: Derived, noteType: string, noteName: string, today: Date): string {
  if (noteType in d.EPISODIC_DIRS) return `${titleCase(noteType)} ${ym(today)}`;
  return titleCase(noteName);
}

export function createNote(d: Derived, path: string, noteType: string, noteName: string, today: Date): void {
  const title = titleFor(d, noteType, noteName, today);
  const content =
    `---\nupdated: ${ymd(today)}\ntags: [${noteType}]\ntype: ${noteType}\n---\n\n` +
    `# ${title}\n\n## Summary\n_(none yet)_\n\n## Notes\n\n## Related\n_(none yet)_\n`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

/** Insert index inside ## Notes: right after the last existing bullet (or the heading itself),
 *  before any blank-line-then-next-heading — keeps that separating blank line intact. */
function findNotesInsertIdx(lines: string[]): number {
  let inNotes = false;
  let idx = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === "## Notes") {
      inNotes = true;
      idx = i + 1;
      continue;
    }
    if (!inNotes) continue;
    if (lines[i].startsWith("## ")) return idx;
    if (lines[i].startsWith("- ")) idx = i + 1;
  }
  return idx;
}

export function insertBullet(path: string, fact: string, today: Date, vaultRoot: string, validTypes: Set<string>, edgeTypes?: Set<string>): void {
  const original = readFileSync(path);
  const lines = splitLines(original.toString("utf8"));

  const parsed = parseFrontmatter(lines);
  if (parsed === null) throw new Error(`${path}: frontmatter missing or malformed`);

  const todayStr = ymd(today);
  // 1. bump updated: (fmLineNo returns 1-based file line; fm starts at file line 2).
  // If the note has no updated: field, insert one right after the opening `---`
  // rather than clobbering whatever sits on the first frontmatter line.
  const updatedFileLine = fmLineNo(parsed.fm, "updated", 2, -1);
  if (updatedFileLine === -1) lines.splice(1, 0, `updated: ${todayStr}`);
  else lines[updatedFileLine - 1] = `updated: ${todayStr}`;

  // 2. insert dated bullet at end of ## Notes
  const idx = findNotesInsertIdx(lines);
  lines.splice(idx, 0, `- ${todayStr}: ${fact}`);

  const newText = lines.join("\n") + "\n";
  writeFileSync(path, newText, "utf8");

  // 3. validate in-process; restore on failure
  const [, errs] = validateVaultNote(path, vaultRoot, validTypes, edgeTypes);
  if (errs.length) {
    writeFileSync(path, original);
    const detail = errs.map(([ln, m]) => `  :${ln}: ${m}`).join("\n");
    throw new Error(`validator rejected the modified note — restored original.\n${detail}`);
  }
}

const USAGE = `Usage: bun scripts/capture.ts --type <type> [--note <name>] "<fact>"

Append a dated fact to a vault note and bump its updated: date.
  --type <type>   semantic (project|infra|...) or episodic (decision|...)
  --note <name>   note name; required for semantic types, ignored for episodic ones

Examples:
  bun scripts/capture.ts --type project --note vkit "v0.3.1 adds folder routing"
  bun scripts/capture.ts --type decision "decided to defer Phase 4"`;

function main() {
  let type = "", note = "", fact = "";
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: { type: { type: "string" }, note: { type: "string" }, help: { type: "boolean", short: "h" } },
    });
    if (values.help) { console.log(USAGE); process.exit(0); }
    if (!values.type || positionals.length !== 1) throw new Error("need --type and exactly one <fact>");
    type = values.type;
    note = values.note ?? "";
    fact = positionals[0];
  } catch (e: any) {
    consola.error(e.message);
    console.error(USAGE);
    process.exit(2);
  }

  const vaultRoot = resolve(import.meta.dir, "..");
  const d = loadFromScript(import.meta.dir);

  if (fact.includes("\n")) {
    consola.error("fact must be a single line (no newlines)");
    process.exit(2);
  }
  const isSemantic = type in d.SEMANTIC_DIRS;
  if (isSemantic && !note) {
    consola.error(`--note <name> required for semantic type '${pc.cyan(type)}'`);
    process.exit(2);
  }

  const today = new Date();
  let path: string;
  try {
    path = resolvePath(d, vaultRoot, type, note, today);
  } catch (e: any) {
    consola.error(e.message);
    process.exit(2);
  }

  if (!existsSync(path)) {
    consola.info(`note not found — creating: ${pc.cyan(toPosix(relative(vaultRoot, path)))}`);
    createNote(d, path, type, note, today);
  }

  try {
    insertBullet(path, fact, today, vaultRoot, d.VALID_TYPES, d.EDGE_TYPES);
  } catch (e: any) {
    consola.error(e.message);
    process.exit(1);
  }
  consola.success(`captured → ${pc.cyan(toPosix(relative(vaultRoot, path)))}`);
}

if (import.meta.main) runMain(main);
