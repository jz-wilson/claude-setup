import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { collectLogs, render, renderMarkdown } from "./dashboard.ts";
import { loadNotesFromVault, search } from "./search.ts";
import { agentLog, makeVault, note, type FixtureVault } from "./test-fixture.ts";

describe("dashboard", () => {
  let v: FixtureVault;
  beforeEach(() => { v = makeVault(); });
  afterEach(() => v.cleanup());

  test("groups live logs by status and links each row; archived logs are left out", () => {
    v.write("agents/tester/reports/2026-10-01-a.md", agentLog({ date: "2026-10-01", status: "active", task: "Alpha | pipe" }));
    v.write("agents/tester/reports/2026-10-02-b.md", agentLog({ date: "2026-10-02", status: "completed", task: "Beta" }));
    v.write("agents/tester/reports/2026-10-03-c.md", agentLog({ date: "2026-10-03", status: "blocked", task: "Gamma" }));
    v.write("agents/tester/reports/archive/2026-01-01-old.md", agentLog({ date: "2026-01-01", status: "completed", task: "Old" }));
    const logs = collectLogs(v.root);
    expect(logs.map((l) => l.task).sort()).toEqual(["Alpha | pipe", "Beta", "Gamma"]);
    const md = renderMarkdown(logs);
    expect(md).toContain("## Needs you (awaiting approval or blocked) (1)");
    expect(md).toContain("## Completed, unverified (1)");
    expect(md).toContain("[Beta](../agents/tester/reports/2026-10-02-b.md)");
    expect(md).toContain("Alpha \\| pipe");
    expect(md).not.toMatch(/^---/);
    expect(render(logs)).toContain("Active (1)");
  });

  test("an empty vault still renders every section", () => {
    const md = renderMarkdown([]);
    for (const t of ["Needs you", "Errors", "Active", "Completed, unverified", "Completed, verified"]) expect(md).toContain(t);
  });
});

describe("search", () => {
  let v: FixtureVault;
  beforeEach(() => { v = makeVault(); });
  afterEach(() => v.cleanup());

  test("finds a term in a project note and never returns personal/ or restricted notes", () => {
    v.write("projects/demo.md", note({ type: "project", updated: "2026-10-01", title: "Demo", notes: ["zebracorn rollout plan"] }));
    v.write("personal/secret.md", note({ type: "personal", updated: "2026-10-01", title: "Secret", notes: ["zebracorn passport"] }));
    v.write("projects/flagged.md", note({ type: "project", updated: "2026-10-01", title: "Flagged", notes: ["zebracorn"] }).replace("type: project", "type: project\nrestricted: true"));
    const hits = search(loadNotesFromVault(v.root), "zebracorn");
    expect(hits.map((h) => h.path)).toEqual(["projects/demo.md"]);
  });
});
