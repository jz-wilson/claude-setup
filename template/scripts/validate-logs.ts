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
const ABS_PATH_RE = /file:\/\/|\b[A-Za-z]:[\\/]|(^|[\s(])\/(Users|home|mnt)\//;
const realDate = (d: string) => { const t = new Date(`${d}T00:00:00Z`); return !isNaN(+t) && t.toISOString().startsWith(d); };
const isLog =(rel: string) => /^agents\/[^/]+\/reports\/[^/]+\.md$/.test(rel.replaceAll("\\", "/"));

export function validate(path: string): string[] {
  const errors: string[] = [];
  const add = (line: number, msg: string) => errors.push(`${relative(ROOT, path)}:${line}: ${msg}`);
  if (!NAME_RE.test(basename(path))) add(1, "filename must be YYYY-MM-DD-slug.md");

  const lines = readFileSync(path, "utf8").replace(/^﻿/, "").split(/\r?\n/);
  const close = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  if (close < 0) { add(1, "file must start with a --- frontmatter block"); return errors; }

  const fm = new Map<string, string>();
  for (const l of lines.slice(1, close)) {
    const m = l.match(/^([a-z_]+):\s*(.*?)\s*$/);
    if (m) fm.set(m[1], m[2].replace(/^"(.*)"$/, "$1"));
  }
  for (const f of REQUIRED) if (!fm.has(f)) add(1, `missing frontmatter field '${f}'`);
  const get = (k: string) => fm.get(k) ?? "";
  if (fm.has("type") && get("type") !== "agent-log") add(1, `'type' must be agent-log, got '${get("type")}'`);
  if (fm.has("status") && !STATUS.includes(get("status"))) add(1, `'status' must be one of ${STATUS.join(", ")}`);
  if (fm.has("priority") && !PRIORITY.includes(get("priority"))) add(1, `'priority' must be one of ${PRIORITY.join(", ")}`);
  for (const f of ["date", "updated"])
    if (fm.has(f) && !(DATE_RE.test(get(f)) && realDate(get(f)))) add(1, `'${f}' must be a real YYYY-MM-DD date`);
  if (fm.has("tags") && !/\bagent-log\b/.test(get("tags"))) add(1, "'tags' must contain agent-log");
  if (fm.has("agent") && !get("agent")) add(1, "'agent' must be non-empty");

  const body = lines.slice(close + 1);
  const text = body.join("\n");
  if (get("status") === "error") {
    if (!["transient", "permanent"].includes(get("error_class"))) add(1, "status error needs error_class: transient|permanent");
    if (!text.includes("## Error Log")) add(close + 2, "status error needs a '## Error Log' section");
  }
  if (get("status") === "completed") {
    if (get("completion_signal") !== "true") add(1, "completed logs need completion_signal: true");
    if (!fm.has("verified")) add(1, "completed logs need verified: false (a human flips it)");
    const v = text.match(/^### Verification\s*\n([\s\S]*?)(?=^#{1,3} |(?![\s\S]))/m);
    if (!v || !v[1].trim()) add(close + 2, "completed logs need a non-empty '### Verification' section (check run -> result)");
  }

  let h1 = 0, fenced = false;
  const sections: string[] = [];
  body.forEach((l, i) => {
    if (l.startsWith("```")) fenced = !fenced;
    if (fenced) return;
    if (/^# /.test(l)) h1++;
    if (/^## /.test(l)) sections.push(l.slice(3).trim());
    if (ABS_PATH_RE.test(l.replace(/`[^`]*`/g, ""))) add(close + 2 + i, "absolute path or file:// URL in body; use a relative link");
  });
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
