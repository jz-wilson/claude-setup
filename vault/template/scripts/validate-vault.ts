#!/usr/bin/env bun
// Vault note validator (agent logs are delegated to validate-logs.ts); types come from vault.config.json.
//   no args -> scan all *.md under vault root (minus skip subtrees)
//   file args -> validate only those
import { readFileSync, existsSync } from "node:fs";
import { relative, resolve, basename } from "node:path";
import {
  DATE_RE, extractField, fmLineNo, extractTagsList, isValidCalendarDate,
  checkBodyPaths, checkHeadings, checkRetiredWikiLinks, splitLines, validateCommonNoteShape, parseFrontmatter,
  extractEdges, validateEdges, type LineError,
} from "./frontmatter.ts";
import { builtinEdgeTypes, loadFromScript, toPosix, NONCONTENT_SUBTREES, inSkippedSubtree, isRestricted, runMain, NOTES_SPLIT_LINES } from "./config.ts";
import { validateAgentLog } from "./validate-logs.ts";
import { blankCode, canonicalId, resolveHref, vaultLinks } from "./links.ts";

export const ROOT_SKIP_FILES = new Set(["CLAUDE.md", "AGENTS.md", "README.md", "_format.md"]);
const SKIP_SUBTREES = new Set([...NONCONTENT_SUBTREES]);
// Only agent-log REPORTS are owned by validate-logs.ts. The rest of agents/ (rollups/, per-agent
// AGENT.md) and all of handoffs/ are ordinary vault notes and are validated here — skipping those
// trees wholesale, as this once did, left them checked by no validator at all.
const AGENT_REPORTS_RE = /^agents\/[^/]+\/reports\//;

// Generated artifacts carry no frontmatter, so the note schema does not apply to them:
// index.md (scripts/index.ts), and graph.md if you add a graph generator.
const GENERATED_BASENAMES = new Set(["index.md", "graph.md"]);

const sortedTypes = (s: Set<string>) => "[" + [...s].sort().map((t) => `'${t}'`).join(", ") + "]";

function validateTags(fm: string[], fmStart: number): LineError[] {
  const errors: LineError[] = [];
  const ln = fmLineNo(fm, "tags", fmStart);
  const tags = extractTagsList(fm);
  if (tags === null) {
    errors.push([ln, "missing required frontmatter field: 'tags'"]);
    return errors;
  }
  for (const tag of tags) {
    if (tag.startsWith("#")) errors.push([ln, `tag '${tag}' must not have a '#' prefix`]);
    if (tag !== tag.toLowerCase()) errors.push([ln, `tag '${tag}' must be lowercase`]);
  }
  return errors;
}

// Types exempt from the "## Notes section too long" split warning: append-only episodic
// logs (decision) where length is inherent to the format, and personal notes —
// restricted-subtree notes are already excluded upstream (see isRestricted below).
const NOTES_SPLIT_EXEMPT_TYPES = new Set(["decision", "personal"]);

/** Line count of the `## Notes` section body (from just after its heading to just before the
 *  next `##` heading, or end of body). Returns null if no `## Notes` heading is present —
 *  callers already require the section to exist via the section-presence check. */
function notesSectionLineCount(body: string[]): number | null {
  const startIdx = body.findIndex((l) => l.trim() === "## Notes");
  if (startIdx < 0) return null;
  let endIdx = body.length;
  for (let i = startIdx + 1; i < body.length; i++) {
    if (/^##\s+\S/.test(body[i])) { endIdx = i; break; }
  }
  return endIdx - (startIdx + 1);
}

/** Warning (not error — never affects exit code) when a note's `## Notes` section is long
 *  enough to warrant splitting into a parent note plus `part-of` children. */
function checkNotesSplit(
  rel: string,
  typeVal: string | null,
  body: string[],
  bodyStart: number,
  threshold: number,
): LineError[] {
  if (typeVal !== null && NOTES_SPLIT_EXEMPT_TYPES.has(typeVal)) return [];
  if (isRestricted(rel)) return [];
  const lines = notesSectionLineCount(body);
  if (lines === null || lines <= threshold) return [];
  return [[bodyStart, `notes section is ${lines} lines (>${threshold}): split into a parent plus part-of children`]];
}

/** `edgeTypes` is optional for the same reason as validateAgentLog's — see that signature.
 *  Third tuple element is WARNINGS — advisory findings that must never affect exit code. */
export function validateVaultNote(
  path: string,
  vaultRoot: string,
  validTypes: Set<string>,
  edgeTypes: Set<string> = builtinEdgeTypes(),
  notesSplitLines: number = NOTES_SPLIT_LINES,
  text?: string,
): [string, LineError[], LineError[]] {
  const errors: LineError[] = [];
  const warnings: LineError[] = [];
  const rel = toPosix(relative(vaultRoot, path));

  const { errors: shapeErrors, shape } = validateCommonNoteShape(path, text);
  errors.push(...shapeErrors);
  if (shape === null) return [rel, errors, warnings];
  const { fm, body, closeLineNo, fmStart } = shape;

  const updatedVal = extractField(fm, "updated");
  if (updatedVal === null) errors.push([fmStart, "missing required frontmatter field: 'updated'"]);
  else if (!DATE_RE.test(updatedVal))
    errors.push([fmLineNo(fm, "updated", fmStart), `'updated' must match YYYY-MM-DD, got: '${updatedVal}'`]);
  else if (!isValidCalendarDate(updatedVal))
    errors.push([fmLineNo(fm, "updated", fmStart), `'updated' is not a real calendar date: '${updatedVal}'`]);

  for (const e of validateTags(fm, fmStart)) errors.push(e);

  const typeVal = extractField(fm, "type");
  if (typeVal === null) errors.push([fmStart, "missing required frontmatter field: 'type'"]);
  else if (!validTypes.has(typeVal))
    errors.push([fmLineNo(fm, "type", fmStart), `'type' must be one of ${sortedTypes(validTypes)}, got: '${typeVal}'`]);

  for (const e of validateEdges(fm, fmStart, edgeTypes)) errors.push(e);

  const bodyStart = closeLineNo + 1;
  for (const e of checkHeadings(body, bodyStart)) errors.push(e);

  for (const e of checkBodyPaths(body, bodyStart)) errors.push(e);
  for (const e of checkRetiredWikiLinks(body, bodyStart)) errors.push(e);
  for (const w of checkNotesSplit(rel, typeVal, body, bodyStart, notesSplitLines)) warnings.push(w);
  return [rel, errors, warnings];
}

/** Link-checking scope, for BOTH body links and edge targets — deliberately wider than
 *  shouldSkip's schema scope. Agent reports and root files like AGENTS.md have their shape
 *  validated elsewhere (or not at all), but a broken link is a broken link regardless of who
 *  owns the note, and `evidence-for` edges originate only on agent-logs. Same normalisation
 *  contract as shouldSkip: pass forward-slash paths. */
export function skipForEdges(rel: string): boolean {
  if (inSkippedSubtree(rel, NONCONTENT_SUBTREES)) return true;
  return GENERATED_BASENAMES.has(basename(rel));
}

/** Schema-validation scope. Callers MUST pass a forward-slash path — normalise Bun.Glob output
 *  with toPosix() first, or every predicate here silently no-ops on Windows. */
export function shouldSkip(rel: string): boolean {
  const parts = rel.split("/");
  if (parts.length === 1 && ROOT_SKIP_FILES.has(parts[0])) return true;
  if (inSkippedSubtree(rel, SKIP_SUBTREES)) return true;
  if (AGENT_REPORTS_RE.test(rel)) return true; // validate-logs.ts owns these
  // generated files carry no frontmatter.
  if (GENERATED_BASENAMES.has(basename(rel))) return true;
  return false;
}

// Cross-file broken-link detection, pure and offline.
// Whole-vault pass: per-file validateVaultNote can't see whether a link resolves.

export interface LinkReport {
  broken: [string, number, string][]; // [rel, line, msg] — hard errors
  /** Every link checkLinks scanned (a Markdown body link or a declared `edges:` target),
   *  resolved or not, whole vault. Additive to `broken` — vault-eval's links.ts metrics derive
   *  their totals/evidence from this instead of re-implementing the same scan, so "resolved"
   *  there means exactly what `bun run validate --links` means. `line` is file-absolute. */
  links: LinkRecord[];
}

export interface LinkRecord {
  path: string;
  line: number;
  kind: "markdown" | "edge";
  /** The href as written (body links) or the canonical id (`edges:` targets). */
  target: string;
  resolved: boolean;
  /** True when the link's source line falls inside the note's `## Related` H2 section
   *  (false for `edges:` targets, which are frontmatter-level, not section-scoped). */
  inRelated: boolean;
  /** The same broken-link message checkLinks would emit — present only when !resolved. */
  msg?: string;
}

/** Standard-Markdown-link resolution, built once per vault scan. THE resolver — checkLinks,
 *  other tools can share it, so "does this link resolve" and "which note
 *  does it point at" can never drift into two different answers. */
export interface LinkResolver {
  /** Canonical vault-relative id without `.md` (e.g. "infrastructure/nodes"), or null. `href`
   *  is resolved relative to the directory of `fromRel` (the note carrying the link) via
   *  `resolveHref`, then matched exactly — case-sensitive, `.md` required, no bare stems, no
   *  basename fallback. A resolvable non-note attachment (`report.pdf`) returns null here; use
   *  `exists` for those. */
  resolve(href: string, fromRel: string): string | null;
  /** Same resolution as `resolve`, but true for a resolvable attachment too (any extension),
   *  not only notes — `[report.pdf](../personal/report.pdf)` is a legitimate link. */
  exists(href: string, fromRel: string): boolean;
  /** A canonical id back to itself if a note exists at that path, else null. `edges[].target`
   *  is already a canonical id, not a relative href, so
   *  edge-target resolution never goes through `resolveHref`/`fromRel`. */
  resolveId(id: string): string | null;
  /** @deprecated retired along with basename/stem resolution when wiki-links were dropped —
   *  always empty. Kept only so existing callers (computeStats, renderArtifact) still compile. */
  ambiguousStems: Map<string, string[]>;
  /** Every note in the vault, canonical form, sorted. */
  allNotes: string[];
  /** Every note file, vault-relative forward-slash path with `.md`, sorted. Full-vault scans
   *  iterate this instead of globbing the vault again. */
  noteFiles: string[];
}

/** One note's text, or null when it cannot be read (dangling symlink / EACCES / delete-race). */
export function readNote(vaultRoot: string, rel: string): string | null {
  try { return readFileSync(resolve(vaultRoot, rel), "utf8"); }
  catch { return null; }
}

// The one subtree buildResolver must never index, even with dot:true: git's own internals
// (objects, refs, HEAD) are not vault content and must never resolve as a link target.
const GIT_INTERNALS = new Set([".git"]);

/** Every ancestor directory of `rel` (vault-relative, forward slashes), e.g. `"a/b/c.md"` ->
 *  `["a", "a/b"]`. Feeds the resolver's directory-link support (`[text](dir/)`). */
function ancestorDirs(rel: string): string[] {
  const parts = rel.split("/");
  parts.pop(); // the file's own basename
  const dirs: string[] = [];
  for (let i = 1; i <= parts.length; i++) dirs.push(parts.slice(0, i).join("/"));
  return dirs;
}

export function buildResolver(vaultRoot: string): LinkResolver {
  // One walk of the vault feeds both notes and attachments. dot:true so a link into a
  // dot-directory (`.claude/skills/x/SKILL.md`, `.github/workflows/x.yml`) resolves — Bun.Glob
  // omits dotfiles/dot-directories by default. `.git/` internals are excluded explicitly;
  // everything else this walked before (node_modules) still does.
  const noteFiles: string[] = [];
  // Exact vault-relative path, case preserved — resolution is case-sensitive.
  const attachments = new Set<string>();
  const directories = new Set<string>();
  for (const raw of new Bun.Glob("**/*").scanSync({ cwd: vaultRoot, dot: true })) {
    const rel = toPosix(raw);
    if (inSkippedSubtree(rel, GIT_INTERNALS)) continue;
    if (rel.endsWith(".md")) noteFiles.push(rel);
    else attachments.add(rel);
    for (const dir of ancestorDirs(rel)) directories.add(dir);
  }
  noteFiles.sort();
  const allNotes = noteFiles.map(canonicalId).sort();
  const noteSet = new Set(noteFiles);
  const idSet = new Set(allNotes);

  const resolve = (href: string, fromRel: string): string | null => {
    const resolved = resolveHref(fromRel, href);
    return resolved !== null && noteSet.has(resolved) ? canonicalId(resolved) : null;
  };

  // A directory link: `href` ends in `/`, or names a directory outright with no
  // extension (`[scripts](../scripts)`) — valid exactly when that directory exists in the
  // vault. An extensionless FILE link (`[LICENSE](../LICENSE)`) is unaffected: it was already
  // handled below by the exact-match `attachments` lookup, since that set holds every
  // non-`.md` path regardless of whether it carries a dot extension.
  const existsAt = (resolved: string): boolean => {
    if (noteSet.has(resolved) || attachments.has(resolved)) return true;
    const bare = resolved.endsWith("/") ? resolved.slice(0, -1) : resolved;
    return bare !== "" && directories.has(bare);
  };

  return {
    resolve,
    exists: (href, fromRel) => {
      const resolved = resolveHref(fromRel, href);
      return resolved !== null && existsAt(resolved);
    },
    resolveId: (id) => (idSet.has(id) ? id : null),
    ambiguousStems: new Map(),
    allNotes,
    noteFiles,
  };
}

/** A link whose target is gitignored is not broken: machine-local notes (`/SYSTEM.md`) and
 *  `personal/` attachments are deliberately absent from a fresh checkout, so a CI clone and a
 *  local tree must agree that `[SYSTEM](SYSTEM.md)` or `[resume.pdf](resume.pdf)` is fine. Asks
 *  git's own ignore rules (no index needed). `target` is either an edge's bare canonical id
 *  (no extension — candidates are guessed at the vault root and at the linking note's
 *  directory) or, for a body link, the link's already-resolved vault-relative path passed with
 *  `sourceRel: ""` (so both guessed candidates collapse to that one exact path). Outside a git
 *  repo this returns false and the link stays broken. */
export function isGitIgnoredLinkTarget(vaultRoot: string, sourceRel: string, target: string): boolean {
  const t = target.trim().split("|")[0].split("#")[0].trim();
  if (!t) return false;
  // Two call shapes (checkLinks below): an edge target is a bare canonical id with no
  // extension, always a note, so `.md` belongs on it — sourceRel is then the linking note's
  // own path, never "". A body link instead passes the already-resolved vault-relative path
  // with sourceRel "", exactly as written: a directory (trailing `/`) or a non-note attachment
  // with no extension (`LICENSE`) must NOT get `.md` appended, or the guess never matches any
  // real .gitignore rule.
  const isEdgeTarget = sourceRel !== "";
  const hasExt = /\.[A-Za-z0-9]+$/.test(t);
  const withExt = isEdgeTarget && !hasExt ? `${t}.md` : t;
  const srcDir = sourceRel.includes("/") ? sourceRel.slice(0, sourceRel.lastIndexOf("/")) : "";
  const candidates = new Set([withExt, srcDir ? `${srcDir}/${withExt}` : withExt]);
  const r = Bun.spawnSync(["git", "check-ignore", "--no-index", "--stdin"], {
    cwd: vaultRoot,
    stdin: Buffer.from(`${[...candidates].join("\n")}\n`),
    stdout: "pipe",
    stderr: "pipe",
  });
  return r.exitCode === 0;
}

/** A link into a git submodule that is not checked out (e.g. a private submodule in CI) cannot be verified, so it is not reported as broken.
 *  When the submodule IS checked out, its notes are in the resolver and links resolve normally. */
export function isUncheckedSubmoduleTarget(vaultRoot: string, target: string): boolean {
  const t = target.trim().split("|")[0].split("#")[0].trim().toLowerCase();
  const gitmodules = resolve(vaultRoot, ".gitmodules");
  if (!existsSync(gitmodules)) return false;
  for (const m of readFileSync(gitmodules, "utf8").matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)) {
    const sub = m[1].replaceAll("\\", "/");
    if (!t.startsWith(`${sub.toLowerCase()}/`)) continue;
    const dir = resolve(vaultRoot, sub);
    const checkedOut = existsSync(dir) && [...new Bun.Glob("**/*.md").scanSync(dir)].length > 0;
    return !checkedOut;
  }
  return false;
}

/** Broken-link detection over the whole vault. Standard-Markdown-link resolution: `[text](href)`
 *  resolves relative to the directory of the note carrying it, case-sensitively, with `.md`
 *  required for a note — no bare stems, no basename fallback.
 *  Existence set spans ALL notes (incl. skip-files like README that are valid link targets);
 *  only non-skipped notes are linted as sources. `read` lets a caller that already read the
 *  notes share that text instead of reading every file again. */
export function checkLinks(
  vaultRoot: string,
  resolver = buildResolver(vaultRoot),
  read: (rel: string) => string | null = (rel) => readNote(vaultRoot, rel),
): LinkReport {
  const broken: [string, number, string][] = [];
  const links: LinkRecord[] = [];

  for (const rel of resolver.noteFiles) {
    if (skipForEdges(rel)) continue;
    const text = read(rel);
    if (text === null) continue; // unreadable note — skip, don't crash the gate
    // Parse frontmatter off so YAML fields (related:, description:) aren't scanned as body links,
    // and body line numbers stay file-accurate. splitLines mirrors the rest of the validator.
    const parsed = parseFrontmatter(splitLines(text));
    const body = parsed ? parsed.body : splitLines(text);
    const startLine = parsed ? parsed.closeLineNo + 1 : 1;

    // Surgical second pass: `edges:` targets are the one frontmatter field that must resolve.
    // Arbitrary frontmatter is still NOT scanned — extractEdges reads that one key and nothing
    // else, so `related:`/`description:` keep escaping link detection exactly as before.
    if (parsed) {
      for (const edge of extractEdges(parsed.fm).edges) {
        const target = resolver.resolveId(edge.link);
        // Same gitignored-target exemption as body links.
        const exempt = target !== null || isGitIgnoredLinkTarget(vaultRoot, rel, edge.link)
          || isUncheckedSubmoduleTarget(vaultRoot, edge.link);
        const msg = exempt ? undefined : `broken edge target ${edge.target} — no matching note`;
        if (msg) broken.push([rel, edge.line, msg]);
        links.push({ path: rel, line: edge.line, kind: "edge", target: edge.link, resolved: exempt, inRelated: false, ...(msg ? { msg } : {}) });
      }
    }

    const bodyText = body.join("\n");
    // inRelated per body-relative line, computed once over the code-blanked text so a heading
    // (or a link) sitting inside a fenced block is never mistaken for a real one — mirrors how
    // vaultLinks() itself ignores code via blankCode().
    const blankedLines = blankCode(bodyText).split("\n");
    const inRelatedByLine: boolean[] = [false];
    let curRelated = false;
    for (const line of blankedLines) {
      const heading = /^##\s+(.+?)\s*$/.exec(line);
      if (heading) curRelated = heading[1].trim() === "Related";
      inRelatedByLine.push(curRelated);
    }

    for (const link of vaultLinks(bodyText)) {
      const lineNo = startLine + link.line - 1;
      const inRelated = inRelatedByLine[link.line] ?? false;

      let resolvedPath: string | null = null;
      let msg: string | undefined;
      if (link.path.startsWith("/")) {
        msg = `broken link [${link.text}](${link.href}) — absolute paths are not allowed`;
      } else {
        resolvedPath = resolveHref(rel, link.href);
        if (resolvedPath === null) {
          msg = `broken link [${link.text}](${link.href}) — escapes the vault`;
        } else if (!resolver.exists(link.href, rel)) {
          // Gitignored/unchecked-submodule targets get the same exemption edges get.
          const exempt = isGitIgnoredLinkTarget(vaultRoot, "", resolvedPath) || isUncheckedSubmoduleTarget(vaultRoot, resolvedPath);
          if (!exempt) msg = `broken link [${link.text}](${link.href}) — no file at ${resolvedPath}`;
        }
      }

      const resolved = msg === undefined;
      if (msg) broken.push([rel, lineNo, msg]);
      links.push({ path: rel, line: lineNo, kind: "markdown", target: link.href, resolved, inRelated, ...(msg ? { msg } : {}) });
    }
  }
  return { broken, links };
}

function isAgentLog(path: string, text?: string): boolean {
  try {
    const parsed = parseFrontmatter(splitLines(text ?? readFileSync(path, "utf8")));
    return parsed !== null && extractField(parsed.fm, "type") === "agent-log";
  } catch {
    return false;
  }
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const linksOnly = argv.includes("--links");
  const args = argv.filter((a) => a !== "--json" && a !== "--links");
  const vaultRoot = resolve(import.meta.dir, "..");
  const { VALID_TYPES, EDGE_TYPES, NOTES_SPLIT_LINES: notesSplitLines } = loadFromScript(import.meta.dir);
  const explicit = args.length > 0;

  // --links: whole-vault broken-link check only, no per-file schema validation.
  // Link health is a whole-vault property, so this is the mode pre-commit uses —
  // it can't schema-flag skip-files (README etc.) the way explicit file args would.
  if (linksOnly) {
    const broken = checkLinks(vaultRoot).broken;
    if (json) {
      console.log(JSON.stringify({ ok: broken.length === 0, errorCount: broken.length,
        errors: broken.map(([path, line, msg]) => ({ path, line, msg })) }, null, 2));
      process.exit(broken.length === 0 ? 0 : 1);
    }
    for (const [path, line, msg] of broken) console.log(`${path}:${line}: ${msg}`);
    console.log(broken.length === 0 ? "✓ links ok" : `✗ ${broken.length} broken link(s)`);
    process.exit(broken.length === 0 ? 0 : 1);
  }

  // Full scan: one resolver (one vault walk) and one read per note, shared by schema
  // validation and the link check below.
  const resolver = explicit ? null : buildResolver(vaultRoot);
  const texts = new Map<string, string | null>();
  const readCached = (rel: string): string | null => {
    if (!texts.has(rel)) texts.set(rel, readNote(vaultRoot, rel));
    return texts.get(rel) ?? null;
  };
  const targets = resolver
    ? resolver.noteFiles.map((p) => resolve(vaultRoot, p)).sort()
    : args.map((a) => resolve(a)).sort();

  const errors: { path: string; line: number; msg: string }[] = [];
  const warnings: { path: string; line: number; msg: string }[] = [];
  let count = 0;
  for (const path of targets) {
    if (!existsSync(path)) {
      errors.push({ path: relative(vaultRoot, path), line: 1, msg: "file not found" });
      continue;
    }
    const rel = toPosix(relative(vaultRoot, path));
    // shouldSkip is a full-scan filter — an explicitly named file is always checked.
    if (!explicit && shouldSkip(rel)) continue;

    count++;
    // Unreadable in a full scan: pass undefined so the validator re-reads and reports why.
    const text = resolver ? readCached(rel) ?? undefined : undefined;
    if (isAgentLog(path, text)) {
      const [r, errs] = validateAgentLog(path, vaultRoot, EDGE_TYPES, text);
      for (const [ln, msg] of errs) errors.push({ path: r, line: ln, msg });
      continue;
    }
    const [r, errs, warns] = validateVaultNote(path, vaultRoot, VALID_TYPES, EDGE_TYPES, notesSplitLines, text);
    for (const [ln, msg] of errs) errors.push({ path: r, line: ln, msg });
    for (const [ln, msg] of warns) warnings.push({ path: r, line: ln, msg });
  }

  // Link health is a whole-vault property — skipped in explicit (changed-files) mode
  // to keep errors scoped to the named files. Pre-commit covers links via `--links`;
  // CI's full scan is the backstop.
  if (resolver)
    for (const [path, line, msg] of checkLinks(vaultRoot, resolver, readCached).broken) errors.push({ path, line, msg });

  if (json) {
    console.log(JSON.stringify({ ok: errors.length === 0, count, errorCount: errors.length, errors, warningCount: warnings.length, warnings }, null, 2));
    process.exit(errors.length === 0 ? 0 : 1);
  }

  for (const e of errors) console.log(`${e.path}:${e.line}: ${e.msg}`);
  for (const w of warnings) console.log(`${w.path}:${w.line}: warning: ${w.msg}`);
  if (errors.length === 0) {
    console.log(warnings.length
      ? `✓ ${count} files validated, 0 errors, ${warnings.length} warning(s)`
      : `✓ ${count} files validated, 0 errors`);
    process.exit(0);
  }
  console.log(`✗ ${count} files validated, ${errors.length} errors found`);
  process.exit(1);
}

if (import.meta.main) runMain(main);
