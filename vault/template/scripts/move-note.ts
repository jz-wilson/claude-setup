#!/usr/bin/env bun
// move-note.ts — move a vault note (typically an agent log into archive/) while keeping
// every link that touches it correct.
//
//   bun scripts/move-note.ts <from> <to> [--dry-run]
//
// <from>/<to> are vault-relative paths (forward slashes, `.md` included). A move rewrites
// three things, and only these three:
//   - Outbound: every vault link inside the moved file itself, re-pointed for its new
//     directory (a relative href's meaning depends on where the file sits).
//   - Inbound: every OTHER note in the vault whose links resolve to the old path, so they
//     keep pointing at the note after it lands at the new one.
//   - Edges: every `edges[].target` anywhere in the vault naming the old canonical id, moved
//     to the new one (edge targets are bare ids, not relative hrefs, so they don't shift on
//     their own the way body links do).
// Everything else — code blocks, unrelated links, files with nothing to change — is left
// byte-identical (line endings and all). Restricted shelves (`personal/`) are
// rewritten like any other note; only paths and counts are ever printed, never content.
import { consola, pc } from "./cli-colors.ts";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { canonicalId, mdLink, resolveHref, vaultLinks } from "./links.ts";
import { inSkippedSubtree, runMain, toPosix } from "./config.ts";

// Deliberately narrower than config.ts's
// NONCONTENT_SUBTREES (which also hides scripts/, dashboard/, .claude/ from ordinary vault
// scanners) — a move must be able to fix a link living in any of those.
const MOVE_SKIP_SUBTREES = new Set([".git", "node_modules"]);

// ---------------------------------------------------------------------------
// Byte-safe raw-line splitting (mirrors migrate-links.ts's splitRaw): keeps every line's
// original terminator (`\n`, `\r\n`, or none on the last line) so a file with nothing to
// change round-trips byte-for-byte.
// ---------------------------------------------------------------------------

interface RawSplit {
  rawLines: string[]; // each element includes its own trailing newline (if any)
  fmEndIdx: number | null; // index into rawLines of the closing '---', or null
}

const stripNl = (l: string) => l.replace(/\r?\n$/, "");

function splitRaw(text: string): RawSplit {
  const rawLines = text.split(/(?<=\n)/);
  if (rawLines.length === 0 || stripNl(rawLines[0]) !== "---") return { rawLines, fmEndIdx: null };
  for (let i = 1; i < rawLines.length; i++) {
    if (stripNl(rawLines[i]) === "---") return { rawLines, fmEndIdx: i };
  }
  return { rawLines, fmEndIdx: null };
}

/** Rewrite every vault link in `bodyText` whose href `remapTarget` accepts (returns a new
 *  target vault-relative path for) to point at that target, keeping the link text and
 *  `#anchor` exactly — `mdLink()` (links.ts) builds the replacement, so escaping and
 *  angle-bracket wrapping match the rest of the vault's tooling exactly. A link
 *  `remapTarget` returns null for is left byte-identical — including its original href
 *  formatting — since it was never touched. `ownerRel` is the vault-relative path of the
 *  file this body will live in once written (the moved file's NEW location for an outbound
 *  rewrite, the unmoved linking file's own path for an inbound one) — `mdLink` computes the
 *  new href relative to it. Operates only on vault-internal links (vaultLinks already
 *  filters out external/mailto/bare-anchor links) and only outside code (vaultLinks ->
 *  extractLinks -> blankCode). */
function spliceLinks(bodyText: string, ownerRel: string, remapTarget: (href: string) => string | null): { text: string; count: number } {
  const links = vaultLinks(bodyText);
  let out = "";
  let cursor = 0;
  let count = 0;
  for (const link of links) {
    const targetRel = remapTarget(link.href);
    if (targetRel === null) continue;
    out += bodyText.slice(cursor, link.index);
    out += mdLink(link.text, ownerRel, targetRel, link.anchor);
    cursor = link.index + link.raw.length;
    count++;
  }
  out += bodyText.slice(cursor);
  return { text: out, count };
}

/** Split `text` into its frontmatter block (opening/closing `---` included, original
 *  newlines intact) and body, applying `rewriteBody` only to the body half — so link
 *  rewriting never touches frontmatter (where `tags: [a, b]` could otherwise look like a
 *  broken link start) and edge rewriting (a separate pass) never touches the body. */
function rewriteBody(text: string, rewriteBodyText: (body: string) => { text: string; count: number }): { text: string; count: number } {
  const { rawLines, fmEndIdx } = splitRaw(text);
  const bodyStart = fmEndIdx === null ? 0 : fmEndIdx + 1;
  const head = rawLines.slice(0, bodyStart).join("");
  const body = rawLines.slice(bodyStart).join("");
  const { text: newBody, count } = rewriteBodyText(body);
  return { text: head + newBody, count };
}

/** Every vault link in the moved file, re-pointed from its NEW location: resolve the href
 *  against the OLD directory (where it was written), then rebuild it relative to the new
 *  one. A link that didn't resolve (escapes the vault) is left byte-identical. */
function rewriteOutboundLinks(text: string, fromRel: string, toRel: string): { text: string; count: number } {
  return rewriteBody(text, (body) => spliceLinks(body, toRel, (href) => resolveHref(fromRel, href)));
}

/** Every vault link in some OTHER file (`fileRel`, unmoved) that resolves to the moved
 *  file's OLD path, re-pointed at its new one. Every other link is left byte-identical. */
function rewriteInboundLinks(text: string, fileRel: string, fromRel: string, toRel: string): { text: string; count: number } {
  return rewriteBody(text, (body) =>
    spliceLinks(body, fileRel, (href) => (resolveHref(fileRel, href) === fromRel ? toRel : null)),
  );
}

/** Every `edges[].target` line inside the frontmatter `edges:` block whose (trimmed,
 *  unquoted) value equals `fromId` is rewritten to `toId`, indentation kept, byte-identical
 *  otherwise. Line-level: only the `target:` line's value changes, nothing else in the
 *  entry. Mirrors frontmatter.ts's own edges-block-extent rule (indented lines or `- `
 *  markers belong to the block; a bare column-0 key ends it) without importing its
 *  unexported helpers. */
function rewriteEdgeTargets(text: string, fromId: string, toId: string): { text: string; count: number } {
  const { rawLines, fmEndIdx } = splitRaw(text);
  if (fmEndIdx === null) return { text, count: 0 };
  const fmStripped = rawLines.slice(1, fmEndIdx).map(stripNl);
  const edgesIdx = fmStripped.findIndex((l) => /^edges:/.test(l));
  if (edgesIdx < 0) return { text, count: 0 };

  let count = 0;
  for (let j = edgesIdx + 1; j < fmStripped.length; j++) {
    const raw = fmStripped[j];
    const s = raw.trim();
    if (s === "") continue;
    const indented = raw.length !== raw.trimStart().length;
    if (!indented && !s.startsWith("- ")) break; // next top-level key: block ends
    const m = /^(\s*)target:\s*(.*)$/.exec(raw);
    if (!m) continue;
    const val = m[2].trim().replace(/^['"]|['"]$/g, "");
    if (val !== fromId) continue;
    const lineIdx = 1 + j;
    const nl = rawLines[lineIdx].slice(stripNl(rawLines[lineIdx]).length);
    rawLines[lineIdx] = `${m[1]}target: ${toId}${nl}`;
    count++;
  }
  return { text: rawLines.join(""), count };
}

function listVaultMdFiles(vaultRoot: string): string[] {
  const out: string[] = [];
  for (const raw of new Bun.Glob("**/*.md").scanSync({ cwd: vaultRoot, dot: true })) {
    const rel = toPosix(raw);
    if (inSkippedSubtree(rel, MOVE_SKIP_SUBTREES)) continue;
    out.push(rel);
  }
  out.sort();
  return out;
}

// ---------------------------------------------------------------------------
// Plan / apply
// ---------------------------------------------------------------------------

export interface InboundEdit {
  rel: string; // vault-relative, posix — the file whose links/edges were rewritten
  text: string; // its full new content
  linksChanged: number;
  edgesChanged: number;
}

export interface MovePlan {
  from: string; // vault-relative, posix, .md included
  to: string;
  fromId: string; // canonicalId(from)
  toId: string; // canonicalId(to)
  /** The moved file's rewritten content, or null when `from` doesn't exist on disk. */
  outbound: { text: string; changed: boolean; linksChanged: number } | null;
  /** Every other file that needed a link or edge-target rewrite, sorted by path. Files with
   *  nothing to change are not listed — and are never touched by applyMove. */
  inbound: InboundEdit[];
}

/** Compute every edit a move from `fromRel` to `toRel` requires, without writing anything.
 *  Reads the vault as it stands right now — for several moves in the same run, plan and
 *  apply one at a time so each later plan sees the earlier move's result (
 *  a plan built against a stale tree would re-break links a prior move already fixed). */
export function planMove(vaultRoot: string, fromRel: string, toRel: string): MovePlan {
  const fromId = canonicalId(fromRel);
  const toId = canonicalId(toRel);

  let outbound: MovePlan["outbound"] = null;
  const fromAbs = resolve(vaultRoot, fromRel);
  if (existsSync(fromAbs)) {
    const original = readFileSync(fromAbs, "utf8");
    const { text, count } = rewriteOutboundLinks(original, fromRel, toRel);
    outbound = { text, changed: text !== original, linksChanged: count };
  }

  const inbound: InboundEdit[] = [];
  for (const rel of listVaultMdFiles(vaultRoot)) {
    if (rel === fromRel) continue;
    let original: string;
    try {
      original = readFileSync(join(vaultRoot, rel), "utf8");
    } catch {
      continue; // unreadable — skip, don't crash the plan
    }
    const linkResult = rewriteInboundLinks(original, rel, fromRel, toRel);
    const edgeResult = rewriteEdgeTargets(linkResult.text, fromId, toId);
    if (linkResult.count || edgeResult.count) {
      inbound.push({ rel, text: edgeResult.text, linksChanged: linkResult.count, edgesChanged: edgeResult.count });
    }
  }
  inbound.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  return { from: fromRel, to: toRel, fromId, toId, outbound, inbound };
}

function isGitRepo(vaultRoot: string): boolean {
  const r = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], { cwd: vaultRoot });
  return r.exitCode === 0;
}

/** Write every edit a plan computed, then move the file. `git: true` (the default) uses
 *  `git mv` when the vault is a git repo, so the move and the rewritten inbound files land
 *  as one coherent change under version control; outside a repo (or with `git: false`) it
 *  falls back to a plain rename. Files with nothing to change are never written. */
export function applyMove(vaultRoot: string, plan: MovePlan, opts: { git?: boolean } = {}): void {
  if (plan.outbound === null) throw new Error(`move-note: source file does not exist: ${plan.from}`);

  for (const edit of plan.inbound) {
    if (edit.linksChanged === 0 && edit.edgesChanged === 0) continue;
    writeFileSync(join(vaultRoot, edit.rel), edit.text, "utf8");
  }

  const fromAbs = resolve(vaultRoot, plan.from);
  const toAbs = resolve(vaultRoot, plan.to);
  mkdirSync(dirname(toAbs), { recursive: true });
  if (plan.outbound.changed) writeFileSync(fromAbs, plan.outbound.text, "utf8");

  const useGit = (opts.git ?? true) && isGitRepo(vaultRoot);
  if (useGit) {
    const r = Bun.spawnSync(["git", "mv", relative(vaultRoot, fromAbs), relative(vaultRoot, toAbs)], { cwd: vaultRoot });
    if (r.exitCode !== 0) throw new Error(`move-note: git mv failed: ${r.stderr.toString().trim()}`);
  } else {
    renameSync(fromAbs, toAbs);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printPlan(plan: MovePlan): void {
  consola.log(`move: ${pc.cyan(plan.from)} -> ${pc.cyan(plan.to)}`);
  consola.log(`  outbound links rewritten: ${plan.outbound?.linksChanged ?? 0}`);
  consola.log(`  inbound files changed:    ${plan.inbound.length}`);
  for (const e of plan.inbound) consola.log(`    ${e.rel}  (links: ${e.linksChanged}, edges: ${e.edgesChanged})`);
}

function main(): void {
  const USAGE = "Usage: bun scripts/move-note.ts <from> <to> [--dry-run]   (vault-relative paths, .md included)";
  let from = "", to = "", dryRun = false;
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { "dry-run": { type: "boolean" }, help: { type: "boolean", short: "h" } } });
    if (values.help) { console.log(USAGE); process.exit(0); }
    if (positionals.length !== 2) throw new Error("need <from> and <to>");
    [from, to] = positionals;
    dryRun = !!values["dry-run"];
  } catch (e: any) {
    consola.error(e.message);
    console.error(USAGE);
    process.exit(2);
  }

  const vaultRoot = resolve(import.meta.dir, "..");
  const fromRel = toPosix(from);
  const toRel = toPosix(to);

  const plan = planMove(vaultRoot, fromRel, toRel);
  printPlan(plan);

  if (dryRun) {
    consola.info("dry run — nothing written. Re-run without --dry-run to apply.");
    return;
  }
  applyMove(vaultRoot, plan, { git: true });
  consola.success(`moved -> ${pc.cyan(toRel)}`);
}

if (import.meta.main) runMain(main);
