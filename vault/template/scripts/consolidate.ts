#!/usr/bin/env bun
// Archival + distillation worklist. Archival is age-only (completed + >90d), not gated on verified.
//   consolidate.ts           dry-run
//   consolidate.ts --apply   git mv eligible logs to archive/
//   consolidate.ts --archive-only
import { consola, pc } from "./cli-colors.ts";
import { existsSync } from "node:fs";
import { relative, resolve, join, basename, dirname } from "node:path";
import { parseArgs } from "node:util";
import { extractField, readFrontmatterFile, isValidCalendarDate } from "./frontmatter.ts";
import { loadFromScript, runMain, toPosix, type Derived } from "./config.ts";
import { findAgentLogs } from "./validate-logs.ts";
import { resolveHref, vaultLinks } from "./links.ts";
import { applyMove, planMove } from "./move-note.ts";

export const ARCHIVE_THRESHOLD_DAYS = 90;

export function dateOrNull(val: string | null): Date | null {
  if (!val || !/^\d{4}-\d{2}-\d{2}$/.test(val) || !isValidCalendarDate(val)) return null;
  const d = new Date(val + "T00:00:00Z");
  return isNaN(d.getTime()) ? null : d;
}

/** Local calendar date (Y-M-D of `now`) recast as a UTC-midnight Date, so it's
 * comparable to dateOrNull()'s output without local-instant-vs-UTC-midnight drift. */
export function todayCalendarDate(now: Date): Date {
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

/** Resolve a `## Related` link's href against the file it was found in (`fromPath`, an
 *  absolute path) to the linked file's absolute path, or null if it doesn't resolve to a
 *  real file. Links are full relative Markdown paths (see scripts/links.ts) — there is no
 *  bare-stem fallback to search SEMANTIC_DIRS for; a link that doesn't name a real file is
 *  just broken. */
export function resolveRelatedLink(vaultRoot: string, fromPath: string, href: string): string | null {
  const fromRel = relative(vaultRoot, fromPath).replaceAll("\\", "/");
  const resolved = resolveHref(fromRel, href);
  if (!resolved) return null;
  const abs = join(vaultRoot, resolved);
  return existsSync(abs) ? abs : null;
}

/** Markdown-link hrefs found in a note's `## Related` section, in document order. External
 *  links and bare anchors are skipped (vaultLinks already filters them out). */
export function relatedLinkHrefs(body: string[]): string[] {
  let inRelated = false;
  const lines: string[] = [];
  for (const line of body) {
    if (line.startsWith("## Related")) {
      inRelated = true;
      continue;
    }
    if (inRelated && line.startsWith("## ")) break;
    if (inRelated) lines.push(line);
  }
  return vaultLinks(lines.join("\n")).map((l) => l.path);
}

export function findArchivalCandidates(d: Derived, vaultRoot: string, today: Date): [string, string][] {
  const threshold = new Date(todayCalendarDate(today).getTime() - ARCHIVE_THRESHOLD_DAYS * 86400_000);
  const out: [string, string][] = [];
  for (const path of findAgentLogs(vaultRoot)) {
    const f = readFrontmatterFile(path);
    if (!f) continue;
    if (extractField(f.fm, "status") !== "completed") continue;
    const logDate = dateOrNull(extractField(f.fm, "date"));
    if (logDate === null || logDate >= threshold) continue;
    const parts = relative(vaultRoot, path).split(/[\\/]/);
    const agentName = parts[parts.indexOf("agents") + 1];
    out.push([path, agentName]);
  }
  return out;
}

/** Moves each candidate log into its agent's `archive/` dir via move-note.ts's planMove/
 *  applyMove, so relative links inside the moved log, inbound links from the rest of the
 *  vault, and `edges[].target` references all follow it instead of dangling. Candidates are moved one at a time in --apply mode, each
 *  plan built fresh against the vault as the previous move left it, so a later candidate's
 *  plan already sees an earlier one's new path. Dry-run plans are still built one per
 *  candidate against the (unmodified) current tree, purely to report what each move would
 *  rewrite — nothing is written. */
export function archiveLogs(candidates: [string, string][], vaultRoot: string, apply: boolean): boolean {
  if (!candidates.length) {
    consola.info("archive: 0 candidates (nothing to do)");
    return true;
  }
  consola.info(`archive: ${pc.cyan(String(candidates.length))} candidate(s)${apply ? "" : pc.yellow("  [DRY RUN — use --apply to execute]")}`);
  let ok = true;
  for (const [path, agentName] of candidates) {
    const dest = join(vaultRoot, "agents", agentName, "reports", "archive", basename(path));
    const fromRel = toPosix(relative(vaultRoot, path));
    const toRel = toPosix(relative(vaultRoot, dest));
    const plan = planMove(vaultRoot, fromRel, toRel);
    if (apply) {
      try {
        applyMove(vaultRoot, plan, { git: true });
        consola.success(`archived → ${pc.cyan(toRel)}  (rewrote ${plan.inbound.length} other file(s), ${plan.outbound?.linksChanged ?? 0} outbound link(s))`);
      } catch (e) {
        consola.error(`archiving ${basename(path)}: ${e instanceof Error ? e.message : String(e)}`);
        ok = false;
      }
    } else {
      consola.log(`  would archive → ${pc.cyan(toRel)}  (would rewrite ${plan.inbound.length} other file(s), ${plan.outbound?.linksChanged ?? 0} outbound link(s))`);
    }
  }
  return ok;
}

export function findDistillationCandidates(d: Derived, vaultRoot: string): [string, string][] {
  const pairs: [string, string][] = [];
  const seen = new Set<string>();
  const semanticDirs = new Set(Object.values(d.SEMANTIC_DIRS));
  for (const path of findAgentLogs(vaultRoot)) {
    const f = readFrontmatterFile(path);
    if (!f) continue;
    if (extractField(f.fm, "status") !== "completed") continue;
    const logDate = dateOrNull(extractField(f.fm, "date"));
    if (logDate === null) continue;
    for (const href of relatedLinkHrefs(f.body)) {
      const linked = resolveRelatedLink(vaultRoot, path, href);
      if (!linked) continue;
      if (!semanticDirs.has(basename(dirname(linked)))) continue;
      const key = `${path}|${linked}`;
      if (seen.has(key)) continue; // dedup: same log linking the same note via more than one Related bullet
      seen.add(key);
      const lf = readFrontmatterFile(linked);
      if (!lf) continue;
      const linkedUpdated = dateOrNull(extractField(lf.fm, "updated"));
      if (linkedUpdated === null) continue;
      if (linkedUpdated < logDate) pairs.push([path, linked]);
    }
  }
  return pairs;
}

function printDistillation(pairs: [string, string][], vaultRoot: string): void {
  if (!pairs.length) {
    consola.info("distillation: 0 stale links found — semantic notes appear up to date");
    return;
  }
  consola.info(`distillation: ${pc.cyan(String(pairs.length))} log(s) may have facts not yet in semantic notes`);
  consola.log(pc.dim("  → use capture.ts to fold each fact in, then re-run to confirm resolution\n"));
  for (const [logPath, notePath] of pairs) {
    consola.log(`  [ ] ${relative(vaultRoot, logPath)}`);
    consola.log(`        → update: ${relative(vaultRoot, notePath)}`);
  }
}

function main() {
  const USAGE = `Usage: bun scripts/consolidate.ts [--apply] [--archive-only]
  (dry run by default; --apply moves completed logs older than 90 days into archive/)`;
  let apply = false, archiveOnly = false;
  try {
    const { values } = parseArgs({ options: { apply: { type: "boolean" }, "archive-only": { type: "boolean" }, help: { type: "boolean", short: "h" } } });
    if (values.help) { console.log(USAGE); process.exit(0); }
    apply = !!values.apply;
    archiveOnly = !!values["archive-only"];
  } catch (e: any) {
    consola.error(e.message);
    console.error(USAGE);
    process.exit(2);
  }

  const vaultRoot = resolve(import.meta.dir, "..");
  const d = loadFromScript(import.meta.dir);
  const today = new Date();

  const archiveOk = archiveLogs(findArchivalCandidates(d, vaultRoot, today), vaultRoot, apply);
  if (!archiveOnly) {
    consola.log("");
    printDistillation(findDistillationCandidates(d, vaultRoot), vaultRoot);
  }
  if (!archiveOk) process.exit(1);
}

if (import.meta.main) runMain(main);
