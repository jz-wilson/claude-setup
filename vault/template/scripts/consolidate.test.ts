import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { archiveLogs, findArchivalCandidates, findDistillationCandidates } from "./consolidate.ts";
import { buildResolver, checkLinks } from "./validate-vault.ts";
import { agentLog, makeVault, note, type FixtureVault } from "./test-fixture.ts";

let v: FixtureVault;
const today = new Date(2026, 8, 7); // 2026-09-07

beforeEach(() => {
  v = makeVault();
});
afterEach(() => {
  v.cleanup();
});

const rel = (p: string) => relative(v.root, p).replaceAll("\\", "/");

describe("findArchivalCandidates", () => {
  test("selects completed logs older than 90 days and nothing else", () => {
    v.write("agents/tester/reports/2026-01-10-old-done.md", agentLog({ date: "2026-01-10", status: "completed", task: "Old done" }));
    v.write("agents/tester/reports/2026-01-11-old-active.md", agentLog({ date: "2026-01-11", status: "active", task: "Old active" }));
    v.write("agents/tester/reports/2026-09-01-new-done.md", agentLog({ date: "2026-09-01", status: "completed", task: "New done" }));
    const found = findArchivalCandidates(v.d, v.root, today).map(([p, agent]) => [rel(p), agent]);
    expect(found).toEqual([["agents/tester/reports/2026-01-10-old-done.md", "tester"]]);
  });

  test("ignores logs already under archive/", () => {
    v.write("agents/tester/reports/archive/2026-01-10-archived.md", agentLog({ date: "2026-01-10", status: "completed", task: "Archived" }));
    expect(findArchivalCandidates(v.d, v.root, today)).toEqual([]);
  });

  test("a log exactly at the threshold is not a candidate", () => {
    v.write("agents/tester/reports/2026-06-09-edge.md", agentLog({ date: "2026-06-09", status: "completed", task: "Edge" }));
    expect(findArchivalCandidates(v.d, v.root, today)).toEqual([]);
  });
});

describe("findDistillationCandidates", () => {
  test("flags a completed log whose linked semantic note is older than the log", () => {
    v.write("projects/alpha.md", note({ type: "project", updated: "2026-05-01", title: "Alpha" }));
    v.write("agents/tester/reports/2026-08-01-work.md", agentLog({ date: "2026-08-01", status: "completed", task: "Work", related: ["- [projects/alpha](../../../projects/alpha.md) — touched"] }));
    const pairs = findDistillationCandidates(v.d, v.root).map(([l, n]) => [rel(l), rel(n)]);
    expect(pairs).toEqual([["agents/tester/reports/2026-08-01-work.md", "projects/alpha.md"]]);
  });

  test("does not flag when the note was updated after the log", () => {
    v.write("projects/alpha.md", note({ type: "project", updated: "2026-08-15", title: "Alpha" }));
    v.write("agents/tester/reports/2026-08-01-work.md", agentLog({ date: "2026-08-01", status: "completed", task: "Work", related: ["- [projects/alpha](../../../projects/alpha.md) — touched"] }));
    expect(findDistillationCandidates(v.d, v.root)).toEqual([]);
  });

  test("dedups a log that links the same note twice and ignores non-semantic links", () => {
    v.write("projects/alpha.md", note({ type: "project", updated: "2026-05-01", title: "Alpha" }));
    v.write("decisions/2026-05.md", note({ type: "decision", updated: "2026-05-01", title: "Decisions" }));
    v.write(
      "agents/tester/reports/2026-08-01-work.md",
      agentLog({
        date: "2026-08-01", status: "completed", task: "Work",
        related: [
          "- [projects/alpha](../../../projects/alpha.md) — a",
          "- [Alpha](../../../projects/alpha.md) — b",
          "- [decisions/2026-05](../../../decisions/2026-05.md) — c",
        ],
      }),
    );
    expect(findDistillationCandidates(v.d, v.root).length).toBe(1);
  });
});

describe("archiveLogs", () => {
  test("archiving a log with inbound/outbound links leaves the vault link-clean (move-note.ts wiring)", () => {
    v.write("AGENTS.md", note({ type: "reference", updated: "2026-01-10", title: "Agent Protocol" }));
    v.write(
      "agents/tester/reports/2026-01-10-old.md",
      agentLog({
        date: "2026-01-10", status: "completed", task: "Old",
        related: ["- [AGENTS](../../../AGENTS.md) — protocol"],
      }),
    );
    v.write(
      "projects/p.md",
      note({ type: "project", updated: "2026-01-10", title: "P", related: ["- [old log](../agents/tester/reports/2026-01-10-old.md) — touched"] }),
    );

    const candidates = findArchivalCandidates(v.d, v.root, today);
    expect(candidates.length).toBe(1);
    const ok = archiveLogs(candidates, v.root, true);
    expect(ok).toBe(true);

    const moved = readFileSync(join(v.root, "agents/tester/reports/archive/2026-01-10-old.md"), "utf8");
    expect(moved).toContain("[AGENTS](../../../../AGENTS.md)");
    const p = readFileSync(join(v.root, "projects/p.md"), "utf8");
    expect(p).toContain("[old log](../agents/tester/reports/archive/2026-01-10-old.md)");

    const report = checkLinks(v.root, buildResolver(v.root));
    expect(report.broken).toEqual([]);
  });
});
