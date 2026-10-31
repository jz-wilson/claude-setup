#!/usr/bin/env bun
// Stale agent-log sweep — implements the stale-log policy (see _format.md, Agent Log
// Extension Rules): an agent-log in `active` or `blocked` whose `date:` is more than
// STALE_THRESHOLD_DAYS old is abandoned (never activity-tracked beyond that field).
// `awaiting-approval` logs never auto-expire — they are listed for the human to act on.
// `active` logs younger than the abandon threshold but older than WARN_THRESHOLD_DAYS
// are listed as a warning only; nothing is written for them.
//
//   stale-logs.ts            dry-run — prints the three groups
//   stale-logs.ts --apply    performs the abandon edits (status -> error) and validates
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parseFrontmatter, extractField, splitLines, isValidCalendarDate } from "./frontmatter.ts";
import { loadFromScript, runMain } from "./config.ts";
import { findAgentLogs, validateAgentLog } from "./validate-logs.ts";
const ymd = (d: Date): string => d.toISOString().slice(0, 10);

const STALE_THRESHOLD_DAYS = 30;
const WARN_THRESHOLD_DAYS = 3;

function dateOrNull(val: string | null): Date | null {
  if (!val || !/^\d{4}-\d{2}-\d{2}$/.test(val) || !isValidCalendarDate(val)) return null;
  const d = new Date(val + "T00:00:00Z");
  return isNaN(d.getTime()) ? null : d;
}

function todayCalendarDate(now: Date): Date {
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function ageDays(logDate: Date, today: Date): number {
  return Math.floor((todayCalendarDate(today).getTime() - logDate.getTime()) / 86400_000);
}

interface LogInfo {
  path: string;
  status: string | null;
  date: Date | null;
  dateRaw: string | null;
  age: number | null;
}

function scan(vaultRoot: string, today: Date): LogInfo[] {
  const out: LogInfo[] = [];
  for (const path of findAgentLogs(vaultRoot)) {
    let fm: string[];
    try {
      const parsed = parseFrontmatter(splitLines(readFileSync(path, "utf8")));
      if (!parsed) continue;
      fm = parsed.fm;
    } catch {
      continue;
    }
    const status = extractField(fm, "status");
    const dateRaw = extractField(fm, "date");
    const date = dateOrNull(dateRaw);
    out.push({ path, status, date, dateRaw, age: date ? ageDays(date, today) : null });
  }
  return out;
}

/** Rewrite one log's frontmatter status to error/permanent, preserving field order and
 *  everything else byte-for-byte, then append the Error Log section after ## Related. */
function abandonLog(path: string, today: Date): void {
  const raw = readFileSync(path, "utf8");
  const lines = splitLines(raw);
  const parsed = parseFrontmatter(lines);
  if (!parsed) throw new Error(`${path}: no parseable frontmatter`);
  const { fm, body } = parsed;

  const newFm = fm.map((line) => {
    if (/^status:/.test(line.trim())) return "status: error";
    return line;
  });
  // error_class: insert right after status if absent, to keep required-field ordering sane.
  if (!newFm.some((l) => /^error_class:/.test(l.trim()))) {
    const idx = newFm.findIndex((l) => /^status:/.test(l.trim()));
    newFm.splice(idx + 1, 0, "error_class: permanent");
  } else {
    for (let i = 0; i < newFm.length; i++) {
      if (/^error_class:/.test(newFm[i].trim())) newFm[i] = "error_class: permanent";
    }
  }

  const stamp = `${ymd(today)}: abandoned; no activity for >30 days, closed by stale-log policy`;
  const bodyText = body.join("\n");
  const relatedIdx = body.findIndex((l) => l.startsWith("## Related"));
  let newBody: string[];
  if (bodyText.includes("## Error Log")) {
    // Already has an Error Log section (shouldn't happen for active/blocked, but be safe):
    // append the stamp as a new bullet at the end of that section.
    newBody = [...body, "", stamp];
  } else if (relatedIdx >= 0) {
    // Find end of Related section (next "## " or EOF).
    let end = body.length;
    for (let i = relatedIdx + 1; i < body.length; i++) {
      if (body[i].startsWith("## ")) { end = i; break; }
    }
    newBody = [...body.slice(0, end), "", "## Error Log", "", `- ${stamp}`, "", ...body.slice(end)];
    // trim a possible trailing blank line duplication at end-of-file insert
    if (end === body.length) {
      // remove trailing blank lines introduced right before EOF, then ensure single trailing newline via join below
      while (newBody.length && newBody[newBody.length - 1] === "") newBody.pop();
    }
  } else {
    newBody = [...body, "", "## Error Log", "", `- ${stamp}`];
  }

  const out = ["---", ...newFm, "---", ...newBody].join("\n") + "\n";
  writeFileSync(path, out, "utf8");
}

function main() {
  const apply = process.argv.includes("--apply");
  const vaultRoot = resolve(import.meta.dir, "..");
  const { EDGE_TYPES } = loadFromScript(import.meta.dir);
  const today = new Date();
  const logs = scan(vaultRoot, today);

  const abandonCandidates = logs.filter(
    (l) => (l.status === "active" || l.status === "blocked") && l.age !== null && l.age > STALE_THRESHOLD_DAYS
  );
  const awaitingApproval = logs.filter((l) => l.status === "awaiting-approval");
  const activeWarnings = logs.filter(
    (l) => l.status === "active" && l.age !== null && l.age > WARN_THRESHOLD_DAYS && l.age <= STALE_THRESHOLD_DAYS
  );

  const rel = (p: string) => relative(vaultRoot, p).replaceAll("\\", "/");

  console.log(`abandon candidates (status active|blocked, date >${STALE_THRESHOLD_DAYS}d old)${apply ? "" : "  [DRY RUN]"}: ${abandonCandidates.length}`);
  for (const l of abandonCandidates) console.log(`  ${rel(l.path)}  status=${l.status} date=${l.dateRaw} age=${l.age}d`);

  console.log(`\nawaiting-approval (never auto-expire; listed for human): ${awaitingApproval.length}`);
  for (const l of awaitingApproval) console.log(`  ${rel(l.path)}  date=${l.dateRaw ?? "?"} age=${l.age ?? "?"}d`);

  console.log(`\nactive >${WARN_THRESHOLD_DAYS}d warning only (not abandoned): ${activeWarnings.length}`);
  for (const l of activeWarnings) console.log(`  ${rel(l.path)}  date=${l.dateRaw} age=${l.age}d`);

  if (!apply) return;

  console.log(`\napplying ${abandonCandidates.length} abandon edit(s)...`);
  let failed = 0;
  for (const l of abandonCandidates) {
    abandonLog(l.path, today);
    const [r, errs] = validateAgentLog(l.path, vaultRoot, EDGE_TYPES);
    if (errs.length) {
      failed++;
      console.log(`  ✗ ${r}: ${errs.length} validation error(s) after edit`);
      for (const [ln, msg] of errs) console.log(`      ${r}:${ln}: ${msg}`);
    } else {
      console.log(`  ✓ ${rel(l.path)} -> status: error (permanent)`);
    }
  }
  if (failed) process.exit(1);
}

if (import.meta.main) runMain(main);
