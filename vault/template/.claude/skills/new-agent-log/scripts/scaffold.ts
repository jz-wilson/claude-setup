#!/usr/bin/env bun
// Scaffold a new agent log at status: active, with the frontmatter in canonical order and the
// ## Summary / ## Notes / ## Related body. Prints the vault-relative path it wrote.
//   bun .claude/skills/new-agent-log/scripts/scaffold.ts --task "One sentence" [--title T]
//       [--slug s] [--priority high|medium|low] [--agent a] [--date YYYY-MM-DD] [--root dir] [--force]
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").slice(0, 6).join("-");
const titleize = (slug: string) => slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const { values } = parseArgs({
  options: {
    task: { type: "string" }, title: { type: "string" }, slug: { type: "string" },
    priority: { type: "string", default: "medium" }, agent: { type: "string", default: "claude-code" },
    date: { type: "string" }, root: { type: "string", default: "." }, force: { type: "boolean" },
  },
});

const fail = (msg: string): never => {
  console.error(`scaffold: ${msg}`);
  process.exit(2);
};
if (!values.task) fail("--task is required");
if (!["high", "medium", "low"].includes(values.priority!)) fail("--priority must be high, medium or low");
const date = values.date ?? localDate();
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail("--date must be YYYY-MM-DD");
const slug = values.slug ? slugify(values.slug) : slugify(values.task!);
if (!slug) fail("could not derive a slug; pass --slug");
if (!/^[a-z0-9][a-z0-9-]*$/.test(values.agent!)) fail("--agent must be lowercase and hyphenated");

const root = resolve(values.root!);
const dir = join(root, "agents", values.agent!, "reports");
const path = join(dir, `${date}-${slug}.md`);
if (existsSync(path) && !values.force) fail(`${relative(root, path)} exists; edit it, or pass --force`);

const task = values.task!.replace(/"/g, '\\"');
const text = `---
updated: ${date}
tags: [agent-log]
type: agent-log
agent: "${values.agent}"
status: active
task: "${task}"
priority: ${values.priority}
date: ${date}
---

# ${values.title ?? titleize(slug)}

## Summary
_(fill in when the task ends)_

## Notes
_(none yet)_

### Verification
_(fill in: each check run and its result)_

## Related
_(none yet)_
`;
mkdirSync(dir, { recursive: true });
writeFileSync(path, text, "utf8");
console.log(relative(root, path).replaceAll("\\", "/"));
