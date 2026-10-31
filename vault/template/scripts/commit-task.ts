#!/usr/bin/env bun
// One git commit per agent task, fired at log completion.
//   commit-task.ts <path-to-agent-log> [-m "<message>"] [--dry-run] [--no-record]
//
// - Validates the log with validate-logs.ts's own logic (imported, not duplicated).
// - Requires status: completed or status: error.
// - Stages the log plus the vault-relative paths in its optional `files:` frontmatter list.
//   With no `files:` list, stages every modified/untracked file `git status --porcelain`
//   reports (git already excludes ignored paths).
// - Commits, then updates the log's `commits:` YAML list with the new SHA and makes a
//   second small commit recording that update (skippable with --no-record).
// - Never runs with --no-verify; never amends.
import { consola, pc } from "./cli-colors.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { validateAgentLog } from "./validate-logs.ts";
import { extractField, extractFmLists, parseFrontmatter, splitLines } from "./frontmatter.ts";
import { loadFromScript, runMain } from "./config.ts";

function gitOrThrow(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr.toString() || r.stdout.toString()).trim()}`);
  return r.stdout.toString();
}

/** `git status --porcelain` entries, relative-to-root paths only (rename entries collapse
 *  to their destination path — the source is already gone from the working tree). */
export function porcelainPaths(porcelain: string): string[] {
  const out: string[] = [];
  for (const raw of porcelain.split("\n")) {
    if (!raw.trim()) continue;
    const rest = raw.slice(3); // XY + one space
    const path = rest.includes(" -> ") ? rest.split(" -> ")[1] : rest;
    out.push(path.replace(/^"|"$/g, ""));
  }
  return out;
}

function truncateSubject(s: string, max = 72): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}

/** Insert `commits:` into frontmatter, appending to an existing list or creating a new one-entry inline list. */
export function addCommitSha(fm: string[], sha: string): string[] {
  const idx = fm.findIndex((l) => /^commits:/.test(l));
  if (idx === -1) {
    // Insert after the first of these keys that exists, in this priority order; with none of
    // them, after the last frontmatter line.
    const anchors = ["cost_usd", "tokens_out", "tokens_in", "retry_count", "error_class", "completion_signal", "verified", "date"];
    let anchorIdx = -1;
    for (const a of anchors) {
      const i = fm.findIndex((l) => new RegExp(`^${a}:`).test(l));
      if (i !== -1) {
        anchorIdx = i;
        break;
      }
    }
    if (anchorIdx === -1) anchorIdx = fm.length - 1;
    const out = [...fm];
    out.splice(anchorIdx + 1, 0, `commits: ["${sha}"]`);
    return out;
  }
  // Existing commits: field, inline (`[a, b]`, comment allowed) or block (`- a` lines):
  // rewrite it as one inline list with the new SHA appended.
  const uncommented = fm.map((l, i) => (i === idx ? l.replace(/\s+#.*$/, "") : l));
  const existing = (extractFmLists(uncommented).get("commits") ?? []).map((s) => s.replace(/^["']|["']$/g, ""));
  let end = idx + 1;
  while (end < fm.length && /^\s+-\s/.test(fm[end])) end++;
  const out = [...fm];
  out.splice(idx, end - idx, `commits: [${[...existing, sha].map((s) => `"${s}"`).join(", ")}]`);
  return out;
}

function main() {
  const USAGE = `Usage: bun scripts/commit-task.ts <log> [-m "<message>"] [--dry-run] [--no-record]
  -m, --message  commit message (first line is the subject; the rest becomes the body)
  --dry-run      print the commit that would be made, without writing anything
  --no-record    skip the second commit that records the SHA back into the log`;
  let logArg = "", message = "", dryRun = false, noRecord = false;
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        message: { type: "string", short: "m" }, "dry-run": { type: "boolean" },
        "no-record": { type: "boolean" }, help: { type: "boolean", short: "h" },
      },
    });
    if (values.help) { console.log(USAGE); process.exit(0); }
    if (positionals.length !== 1) throw new Error("need exactly one <log>");
    logArg = positionals[0];
    message = values.message ?? "";
    dryRun = !!values["dry-run"];
    noRecord = !!values["no-record"];
  } catch (e: any) {
    consola.error(e.message);
    console.error(USAGE);
    process.exit(2);
  }

  const vaultRoot = resolve(import.meta.dir, "..");
  const logPath = resolve(logArg);
  if (!existsSync(logPath)) throw new Error(`log not found: ${logArg}`);

  const { EDGE_TYPES } = loadFromScript(import.meta.dir);
  const [rel, errs] = validateAgentLog(logPath, vaultRoot, EDGE_TYPES);
  if (errs.length) {
    for (const [ln, msg] of errs) consola.error(`${rel}:${ln}: ${msg}`);
    throw new Error(`log fails validation — fix before committing (${errs.length} error(s))`);
  }

  const text = readFileSync(logPath, "utf8");
  const lines = splitLines(text);
  const parsed = parseFrontmatter(lines);
  if (!parsed) throw new Error(`${rel}: frontmatter missing or malformed`);
  const { fm } = parsed;

  const status = extractField(fm, "status");
  if (status !== "completed" && status !== "error")
    throw new Error(`${rel}: status is '${status}', must be 'completed' or 'error' to commit`);

  const agent = extractField(fm, "agent") ?? "agent";
  const task = extractField(fm, "task") ?? "";
  const session = extractField(fm, "session");

  const relLog = relative(vaultRoot, logPath).replaceAll("\\", "/");
  const listed = extractFmLists(fm).get("files");
  const files = listed
    ? [relLog, ...listed.filter((f) => f !== relLog)]
    : porcelainPaths(gitOrThrow(vaultRoot, ["status", "--porcelain", "-uall"]));

  consola.info(`staging ${pc.cyan(String(files.length))} file(s):`);
  for (const f of files) consola.log(`  ${f}`);

  // A multi-line -m keeps its first line as the subject and the rest (including
  // any trailers the caller wrote) as body ahead of the file list.
  const [msgSubject = "", ...msgRest] = (message || "").split("\n");
  const subject = truncateSubject(msgSubject || `${agent}: ${task}`);
  const extra = msgRest.join("\n").trim();
  const fileList = files.length ? `\nFiles:\n${files.map((f) => `- ${f}`).join("\n")}\n` : "\n";
  const body = (extra ? `\n${extra}\n` : "") + fileList;
  const trailer = session ? `\nClaude-Session: ${session}\n` : "\n";
  const commitMsg = `${subject}\n${body}${trailer}`.replace(/\n{3,}/g, "\n\n");

  if (dryRun) {
    consola.info("dry run: would commit with message");
    consola.log(pc.dim("--- commit message ---"));
    consola.log(commitMsg);
    consola.log(pc.dim("--- end (no commit made) ---"));
    return;
  }

  if (files.length === 0) throw new Error("nothing to stage — git status --porcelain is empty");

  // With a files: list, stage only those paths (`add -A -- <paths>` also stages their
  // deletions); without one, the whole tree. Commit the index, never a pathspec: a partial
  // commit would drop what the pre-commit hook stages (the regenerated index.md files).
  gitOrThrow(vaultRoot, listed ? ["add", "-A", "--", ...files] : ["add", "-A"]);
  gitOrThrow(vaultRoot, ["commit", "-m", commitMsg]);
  const sha = gitOrThrow(vaultRoot, ["rev-parse", "HEAD"]).trim();
  consola.success(`committed ${pc.cyan(sha)}`);

  if (noRecord) return;

  const newFm = addCommitSha(fm, sha);
  const newLines = [lines[0], ...newFm, "---", ...parsed.body];
  writeFileSync(logPath, newLines.join("\n") + "\n", "utf8");

  const [rel2, errs2] = validateAgentLog(logPath, vaultRoot, EDGE_TYPES);
  if (errs2.length) {
    for (const [ln, msg] of errs2) consola.error(`${rel2}:${ln}: ${msg}`);
    throw new Error(`updating 'commits:' broke validation — log left modified for manual fix, no second commit made`);
  }

  gitOrThrow(vaultRoot, ["add", "--", relLog]);
  gitOrThrow(vaultRoot, ["commit", "-m", `${agent}: record task commit`]);
  const sha2 = gitOrThrow(vaultRoot, ["rev-parse", "HEAD"]).trim();
  consola.success(`recorded SHA in log, committed ${pc.cyan(sha2)}`);
}

if (import.meta.main) runMain(main);
