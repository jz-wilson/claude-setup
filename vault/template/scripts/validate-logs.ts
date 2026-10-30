#!/usr/bin/env bun
// Agent-log validator. Save as scripts/validate-logs.ts in the vault.
//   bun scripts/validate-logs.ts            check every agents/*/reports/*.md (archive/ skipped)
//   bun scripts/validate-logs.ts a.md b.md  check only those files
//   bun scripts/validate-logs.ts --hook     Claude Code PostToolUse hook: reads the hook JSON on stdin,
//                                           checks the written file if it is an agent log, exits 2 on errors
import { existsSync, readFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const REQUIRED = ["updated", "tags", "type", "agent", "status", "task", "priority", "date"];
const STATUS = ["active", "blocked", "awaiting-approval", "completed", "error"];
const PRIORITY = ["high", "medium", "low"];
const NAME_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*\.md$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ABS_PATH_RE = /file:\/\/|\b[A-Za-z]:[\\/]|\\\\[\w.-]+\\|(^|[\s(])\/(Users|home|mnt|root|var|etc|opt)\//;
const FENCE_RE = /^\s*(```|~~~)/;
const realDate = (d: string) => { const t = new Date(`${d}T00:00:00Z`); return !isNaN(+t) && t.toISOString().startsWith(d); };
const isLog = (rel: string) => /^agents\/[^/]+\/reports\/[^/]+\.md$/.test(rel.replaceAll("\\", "/"));

// Minimal frontmatter parser: `key: value` lines, inline `# comments`, quoted values,
// and lists written either as `[a, b]` or as indented `- a` lines.
function parseFrontmatter(lines: string[]): Map<string, string | string[]> {
  const fm = new Map<string, string | string[]>();
  let listKey = "";
  for (const l of lines) {
    const item = l.match(/^\s+-\s+(.*?)\s*$/);
    if (item && listKey) { (fm.get(listKey) as string[]).push(item[1].replace(/^["']|["']$/g, "")); continue; }
    const m = l.match(/^([a-z_]+):\s*(.*)$/);
    if (!m) continue;
    const value = m[2].replace(/\s+#.*$/, "").trim();
    listKey = "";
    if (value === "") { fm.set(m[1], []); listKey = m[1]; }
    else if (value.startsWith("[") && value.endsWith("]"))
      fm.set(m[1], value.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean));
    else fm.set(m[1], value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"));
  }
  return fm;
}

export function validate(path: string): string[] {
  const errors: string[] = [];
  const add = (line: number, msg: string) => errors.push(`${relative(ROOT, path)}:${line}: ${msg}`);
  if (!NAME_RE.test(basename(path))) add(1, "filename must be YYYY-MM-DD-slug.md");

  const lines = readFileSync(path, "utf8").replace(/^﻿/, "").split(/\r?\n/);
  const close = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  if (close < 0) { add(1, "file must start with a --- frontmatter block"); return errors; }

  const fm = parseFrontmatter(lines.slice(1, close));
  const get = (k: string) => { const v = fm.get(k); return typeof v === "string" ? v : ""; };
  for (const f of REQUIRED) if (!fm.has(f)) add(1, `missing frontmatter field '${f}'`);
  if (fm.has("type") && get("type") !== "agent-log") add(1, `'type' must be agent-log, got '${get("type")}'`);
  if (fm.has("status") && !STATUS.includes(get("status"))) add(1, `'status' must be one of ${STATUS.join(", ")}`);
  if (fm.has("priority") && !PRIORITY.includes(get("priority"))) add(1, `'priority' must be one of ${PRIORITY.join(", ")}`);
  for (const f of ["date", "updated"])
    if (fm.has(f) && !(DATE_RE.test(get(f)) && realDate(get(f)))) add(1, `'${f}' must be a real YYYY-MM-DD date`);
  const tags = fm.get("tags");
  if (fm.has("tags") && !(Array.isArray(tags) && tags.includes("agent-log"))) add(1, "'tags' must be a list containing agent-log");
  if (fm.has("agent") && !get("agent")) add(1, "'agent' must be non-empty");

  // Walk the body outside code fences: headings, sections, and absolute paths.
  const body = lines.slice(close + 1);
  let h1 = 0, fenced = false, h2 = "", inVerification = false, verificationText = "";
  const sections: string[] = [];
  body.forEach((l, i) => {
    if (FENCE_RE.test(l)) { fenced = !fenced; return; }
    if (fenced) { if (inVerification) verificationText += l; return; }
    const heading = l.match(/^(#{1,6}) (.*)$/);
    if (heading) {
      const [level, title] = [heading[1].length, heading[2].trim()];
      if (level === 1) h1++;
      if (level === 2) { h2 = title; sections.push(title); }
      if (level <= 3) inVerification = level === 3 && title === "Verification" && h2 === "Notes";
      return;
    }
    if (inVerification) verificationText += l.trim();
    if (ABS_PATH_RE.test(l.replace(/`[^`]*`/g, ""))) add(close + 2 + i, "absolute path or file:// URL in body; use a relative link");
  });

  if (get("status") === "error") {
    if (!["transient", "permanent"].includes(get("error_class"))) add(1, "status error needs error_class: transient|permanent");
    if (!sections.includes("Error Log")) add(close + 2, "status error needs a '## Error Log' section");
  }
  if (get("status") === "completed") {
    if (get("completion_signal") !== "true") add(1, "completed logs need completion_signal: true");
    if (!fm.has("verified")) add(1, "completed logs need verified: false (a human flips it)");
    if (!verificationText) add(close + 2, "completed logs need a non-empty '### Verification' under '## Notes' (check run -> result)");
  }
  if (h1 !== 1) add(close + 2, `need exactly one H1 title, found ${h1}`);
  const order = sections.filter((s) => ["Summary", "Notes", "Related"].includes(s));
  if (order.join() !== "Summary,Notes,Related") add(close + 2, "sections must be ## Summary, ## Notes, ## Related, in that order");
  return errors;
}

function allLogs(): string[] {
  return [...new Bun.Glob("agents/*/reports/*.md").scanSync(ROOT)].map((p) => resolve(ROOT, p)).sort();
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--hook") {
    const input = await Bun.stdin.json().catch(() => ({}));
    const file = input?.tool_input?.file_path;
    if (!file || !isLog(relative(ROOT, resolve(file))) || !existsSync(file)) process.exit(0);
    const errs = validate(resolve(file));
    if (errs.length) { console.error(errs.join("\n")); process.exit(2); }
    process.exit(0);
  }
  const targets = args.length ? args.map((a) => resolve(a)) : allLogs();
  const errs = targets.flatMap((t) => (existsSync(t) ? validate(t) : [`${t}:1: file not found`]));
  for (const e of errs) console.log(e);
  console.log(errs.length ? `✗ ${targets.length} logs, ${errs.length} errors` : `✓ ${targets.length} logs, 0 errors`);
  process.exit(errs.length ? 1 : 0);
}

if (import.meta.main) await main();
