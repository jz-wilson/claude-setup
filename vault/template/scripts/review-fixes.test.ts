// Regression tests for the findings of the template's code review.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isRestricted } from "./config.ts";
import { addCommitSha } from "./commit-task.ts";
import { checkHeadings, extractField, extractFmLists } from "./frontmatter.ts";
import { notesInDir } from "./index.ts";
import { loadNotesFromVault, search } from "./search.ts";
import { join } from "node:path";
import { makeVault, note, type FixtureVault } from "./test-fixture.ts";

test("restricted: true is recognised quoted, capitalised, with a comment, and after a BOM", () => {
  const fm = (line: string) => `---\nupdated: 2026-10-01\n${line}\n---\n# X\n`;
  for (const l of ["restricted: true", "restricted: True", 'restricted: "true"', "restricted: true   # private"])
    expect(isRestricted("projects/x.md", fm(l))).toBe(true);
  expect(isRestricted("projects/x.md", "﻿" + fm("restricted: true"))).toBe(true);
  expect(isRestricted("projects/x.md", fm("restricted: false"))).toBe(false);
});

describe("generated indexes", () => {
  let v: FixtureVault;
  beforeEach(() => { v = makeVault(); });
  afterEach(() => v.cleanup());

  test("index.ts leaves restricted notes out, and search skips index.md", () => {
    v.write("projects/open.md", note({ type: "project", updated: "2026-10-01", title: "Open" }));
    v.write("projects/secret.md", note({ type: "project", updated: "2026-10-01", title: "Walrus" }).replace("type: project", "type: project\nrestricted: true"));
    expect(notesInDir(join(v.root, "projects")).map((n) => n.title)).toEqual(["Open"]);
    v.write("projects/index.md", "# Projects\n- [Walrus](secret.md)\n");
    expect(search(loadNotesFromVault(v.root), "walrus")).toEqual([]);
  });
});

test("a quoted value followed by a comment keeps only the value", () => {
  expect(extractField(['status: "completed" # done'], "status")).toBe("completed");
  expect(extractField(["agent: 'claude-code'  # who"], "agent")).toBe("claude-code");
  expect(extractField(['task: "fix # in title"'], "task")).toBe("fix # in title");
});

test("an inline list followed by a comment parses", () => {
  expect(extractFmLists(["files: [projects/a.md, b.md]  # just these"]).get("files")).toEqual(["projects/a.md", "b.md"]);
});

test("a duplicated section is an error", () => {
  const errs = checkHeadings(["# T", "## Summary", "## Summary", "## Notes", "## Related"], 1);
  expect(errs.map(([, m]) => m).join()).toContain("appears 2 times");
});

test("addCommitSha appends to inline (with comment) and block commits: lists", () => {
  expect(addCommitSha(['commits: ["a1"]     # SHAs', "model: x"], "b2")).toEqual(['commits: ["a1", "b2"]', "model: x"]);
  expect(addCommitSha(["commits:", "  - a1", "  - c3", "model: x"], "b2")).toEqual(['commits: ["a1", "c3", "b2"]', "model: x"]);
  expect(addCommitSha(["date: 2026-10-01"], "b2")).toEqual(["date: 2026-10-01", 'commits: ["b2"]']);
});
