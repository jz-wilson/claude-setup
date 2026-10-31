#!/usr/bin/env bun
// Agent-log validator.
//   bun scripts/validate-logs.ts            check every agents/*/reports/*.md (archive/ skipped)
//   bun scripts/validate-logs.ts a.md b.md  check only those files
//   bun scripts/validate-logs.ts --hook     Claude Code PostToolUse hook: reads the hook JSON on stdin,
//                                           checks the written file if it is an agent log, exits 2 on errors
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve, basename } from "node:path";
import {
  DATE_RE, bodyHeadings, extractField, extractTagsList, fmLineNo, checkBodyPaths, checkHeadings, checkRetiredWikiLinks, isValidCalendarDate,
  validateCommonNoteShape, validateEdges, type LineError,
} from "./frontmatter.ts";
import { builtinEdgeTypes, loadFromScript, runMain } from "./config.ts";

const REQUIRED_FIELDS = ["updated", "tags", "type", "agent", "status", "task", "priority", "date"];
const VALID_STATUS = ["active", "blocked", "awaiting-approval", "completed", "error"];
const VALID_PRIORITY = ["high", "medium", "low"];
const VALID_ERROR_CLASS = ["transient", "permanent"];
const FILENAME_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*\.md$/;

const sortedList = (a: string[]) => "[" + [...a].sort().map((s) => `'${s}'`).join(", ") + "]";

/** `edgeTypes` is optional so external callers keep the old two-arg signature; omitting it
 *  validates against the built-in vocabulary only, losing this vault's `edge_types` extras.
 *  Both in-repo call sites (main() below, validate-vault.ts's dispatch) pass the real set. */
export function validateAgentLog(
  path: string,
  vaultRoot: string,
  edgeTypes: Set<string> = builtinEdgeTypes(),
  text?: string,
): [string, LineError[]] {
  const errors: LineError[] = [];
  const rel = relative(vaultRoot, path).replaceAll("\\", "/"); // uniform with validate-vault output
  const fname = basename(path);

  if (!FILENAME_RE.test(fname))
    errors.push([1, `filename does not match YYYY-MM-DD-slug.md pattern: ${fname}`]);

  const { errors: shapeErrors, shape } = validateCommonNoteShape(path, text);
  errors.push(...shapeErrors);
  if (shape === null) return [rel, errors];
  const { fm, body, closeLineNo, fmStart } = shape;

  for (const field of REQUIRED_FIELDS)
    if (extractField(fm, field) === null)
      errors.push([fmStart, `missing required frontmatter field: '${field}'`]);

  const typeVal = extractField(fm, "type");
  if (typeVal !== null && typeVal !== "agent-log")
    errors.push([fmLineNo(fm, "type", fmStart), `'type' must be 'agent-log', got: '${typeVal}'`]);

  const statusVal = extractField(fm, "status");
  if (statusVal !== null && !VALID_STATUS.includes(statusVal))
    errors.push([fmLineNo(fm, "status", fmStart), `'status' must be one of ${sortedList(VALID_STATUS)}, got: '${statusVal}'`]);

  const priorityVal = extractField(fm, "priority");
  if (priorityVal !== null && !VALID_PRIORITY.includes(priorityVal))
    errors.push([fmLineNo(fm, "priority", fmStart), `'priority' must be one of ${sortedList(VALID_PRIORITY)}, got: '${priorityVal}'`]);

  for (const field of ["date", "updated"]) {
    const val = extractField(fm, field);
    if (val !== null && !DATE_RE.test(val))
      errors.push([fmLineNo(fm, field, fmStart), `'${field}' must match YYYY-MM-DD, got: '${val}'`]);
    else if (val !== null && !isValidCalendarDate(val))
      errors.push([fmLineNo(fm, field, fmStart), `'${field}' is not a real calendar date: '${val}'`]);
  }

  const tagsVal = extractTagsList(fm);
  if (tagsVal !== null && !tagsVal.includes("agent-log"))
    errors.push([fmLineNo(fm, "tags", fmStart), "'tags' must contain 'agent-log'"]);

  const agentVal = extractField(fm, "agent");
  if (agentVal !== null && agentVal.trim() === "")
    errors.push([fmLineNo(fm, "agent", fmStart), "'agent' value must be non-empty"]);

  for (const e of validateEdges(fm, fmStart, edgeTypes)) errors.push(e);

  if (statusVal === "error") {
    const ec = extractField(fm, "error_class");
    if (ec === null) errors.push([fmStart, "status is 'error' but 'error_class' field is missing"]);
    else if (!VALID_ERROR_CLASS.includes(ec))
      errors.push([fmLineNo(fm, "error_class", fmStart), `'error_class' must be one of ${sortedList(VALID_ERROR_CLASS)}, got: '${ec}'`]);
    if (!bodyHeadings(body).some((h) => h.level === 2 && h.title === "Error Log"))
      errors.push([closeLineNo + 1, "status is 'error' but body is missing '## Error Log' section"]);
  }

  // The dashboard's "completed but unverified" list depends on these fields. Archived logs
  // are frozen history, so only live logs are held to the completion rules.
  if (statusVal === "completed" && !rel.split("/").includes("archive")) {
    const cs = extractField(fm, "completion_signal");
    if (cs !== "true")
      errors.push([fmLineNo(fm, "completion_signal", fmStart), "status is 'completed' but 'completion_signal' is not true"]);
    if (extractField(fm, "verified") === null)
      errors.push([fmStart, "status is 'completed' but 'verified' field is missing (write verified: false; a human flips it)"]);
    if (!hasVerificationEvidence(body))
      errors.push([closeLineNo + 1, "status is 'completed' but '### Verification' under ## Notes is missing or empty (list the checks run and their results)"]);
  }

  for (const e of checkHeadings(body, closeLineNo + 1)) errors.push(e);
  for (const e of checkBodyPaths(body, closeLineNo + 1)) errors.push(e);
  for (const e of checkRetiredWikiLinks(body, closeLineNo + 1)) errors.push(e);
  return [rel, errors];
}

/** True when `## Notes` holds a `### Verification` heading followed by at least one real line
 *  (fenced code counts) before the next heading. Placeholders like `_(none yet)_` do not count. */
export function hasVerificationEvidence(body: string[]): boolean {
  const hs = bodyHeadings(body);
  let h2 = "";
  for (let k = 0; k < hs.length; k++) {
    const h = hs[k];
    if (h.level === 1) { h2 = ""; continue; }
    if (h.level === 2) { h2 = h.title; continue; }
    if (h.level !== 3 || h.title !== "Verification" || h2 !== "Notes") continue;
    const end = hs.slice(k + 1).find((n) => n.level <= 3)?.idx ?? body.length;
    if (body.slice(h.idx + 1, end).some((l) => { const t = l.trim(); return t !== "" && !/^_\(.*\)_$/.test(t); })) return true;
  }
  return false;
}

export function findAgentLogs(vaultRoot: string): string[] {
  const glob = new Bun.Glob("agents/**/reports/*.md");
  return [...glob.scanSync(vaultRoot)]
    .filter((p) => !p.split("/").includes("archive"))
    .map((p) => resolve(vaultRoot, p))
    .sort();
}

const isLogPath = (rel: string) => /^agents\/[^/]+\/reports\/[^/]+\.md$/.test(rel.replaceAll("\\", "/"));

function hook(vaultRoot: string): never {
  // Synchronous read: an awaited Bun.stdin read under runMain lets Bun exit before it resolves.
  let input: any = {};
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch { /* no or bad JSON: nothing to check */ }
  const file = input?.tool_input?.file_path;
  if (!file || !isLogPath(relative(vaultRoot, resolve(file))) || !existsSync(file)) process.exit(0);
  const [rel, errs] = validateAgentLog(resolve(file), vaultRoot, loadFromScript(import.meta.dir).EDGE_TYPES);
  if (errs.length) {
    console.error(errs.map(([ln, msg]) => `${rel}:${ln}: ${msg}`).join("\n"));
    process.exit(2);
  }
  process.exit(0);
}

function main() {
  const args = process.argv.slice(2);
  const vaultRoot = resolve(import.meta.dir, "..");
  if (args[0] === "--hook") hook(vaultRoot);
  const targets = args.length ? args.map((a) => resolve(a)).sort() : findAgentLogs(vaultRoot);
  const { EDGE_TYPES } = loadFromScript(import.meta.dir);

  let total = 0;
  let count = 0;
  for (const path of targets) {
    if (!existsSync(path)) {
      console.log(`${path}:1: file not found`);
      total++;
      continue;
    }
    const [rel, errs] = validateAgentLog(path, vaultRoot, EDGE_TYPES);
    count++;
    for (const [ln, msg] of errs) {
      console.log(`${rel}:${ln}: ${msg}`);
      total++;
    }
  }

  if (targets.length === 0) {
    console.log("No files found.");
    process.exit(0);
  }
  if (total === 0) {
    console.log(`✓ ${count} files validated, 0 errors`);
    process.exit(0);
  }
  console.log(`✗ ${count} files validated, ${total} errors found`);
  process.exit(1);
}

if (import.meta.main) runMain(main);
