import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { applyMove, planMove } from "./move-note.ts";
import { buildResolver, checkLinks } from "./validate-vault.ts";
import { agentLog, makeVault, note, type FixtureVault } from "./test-fixture.ts";

let v: FixtureVault;
const rel = (p: string) => relative(v.root, p).replaceAll("\\", "/");

beforeEach(() => {
  v = makeVault();
});
afterEach(() => {
  v.cleanup();
});

describe("planMove — outbound", () => {
  test("a relative link climbing out of the moved file's directory is re-pointed one level deeper", () => {
    v.write(
      "agents/tester/reports/2026-01-10-old.md",
      agentLog({ date: "2026-01-10", status: "completed", task: "Old", related: ["- [AGENTS](../../../AGENTS.md) — protocol"] }),
    );
    const plan = planMove(v.root, "agents/tester/reports/2026-01-10-old.md", "agents/tester/reports/archive/2026-01-10-old.md");
    expect(plan.outbound?.changed).toBe(true);
    expect(plan.outbound?.linksChanged).toBe(1);
    expect(plan.outbound?.text).toContain("[AGENTS](../../../../AGENTS.md)");
  });

  test("a same-folder sibling link gains one '../' after the move", () => {
    v.write(
      "agents/tester/reports/2026-01-10-old.md",
      agentLog({ date: "2026-01-10", status: "completed", task: "Old", related: ["- [sibling](other.md) — sibling log"] }),
    );
    const plan = planMove(v.root, "agents/tester/reports/2026-01-10-old.md", "agents/tester/reports/archive/2026-01-10-old.md");
    expect(plan.outbound?.text).toContain("[sibling](../other.md)");
  });

  test("an anchor on an outbound link survives the rewrite", () => {
    v.write(
      "agents/tester/reports/2026-01-10-old.md",
      agentLog({ date: "2026-01-10", status: "completed", task: "Old", related: ["- [AGENTS](../../../AGENTS.md#notes) — protocol"] }),
    );
    const plan = planMove(v.root, "agents/tester/reports/2026-01-10-old.md", "agents/tester/reports/archive/2026-01-10-old.md");
    expect(plan.outbound?.text).toContain("[AGENTS](../../../../AGENTS.md#notes)");
  });

  test("a link inside a fenced code block is left byte-identical", () => {
    const content = `---\nupdated: 2026-01-10\ntags: [agent-log]\ntype: agent-log\nagent: "tester"\nstatus: completed\ntask: "Old"\npriority: low\ndate: 2026-01-10\ncompletion_signal: true\nverified: false\n---\n\n# Old\n\n## Summary\nFixture log.\n\n## Notes\n\`\`\`\nsee [AGENTS](../../../AGENTS.md) for reference\n\`\`\`\n\n## Related\n_(none yet)_\n`;
    v.write("agents/tester/reports/2026-01-10-old.md", content);
    const plan = planMove(v.root, "agents/tester/reports/2026-01-10-old.md", "agents/tester/reports/archive/2026-01-10-old.md");
    expect(plan.outbound?.changed).toBe(false);
    expect(plan.outbound?.linksChanged).toBe(0);
    expect(plan.outbound?.text).toBe(content);
  });

  test("a link that escapes the vault is left byte-identical", () => {
    const content = `---\nupdated: 2026-01-10\ntags: [agent-log]\ntype: agent-log\nagent: "tester"\nstatus: completed\ntask: "Old"\npriority: low\ndate: 2026-01-10\ncompletion_signal: true\nverified: false\n---\n\n# Old\n\n## Summary\nFixture log.\n\n## Notes\n- see [outside](../../../../../../etc/passwd)\n\n## Related\n_(none yet)_\n`;
    v.write("agents/tester/reports/2026-01-10-old.md", content);
    const plan = planMove(v.root, "agents/tester/reports/2026-01-10-old.md", "agents/tester/reports/archive/2026-01-10-old.md");
    expect(plan.outbound?.linksChanged).toBe(0);
    expect(plan.outbound?.text).toBe(content);
  });
});

describe("planMove — inbound", () => {
  test("a link from elsewhere in the vault is re-pointed at the archived path", () => {
    v.write("agents/tester/reports/2026-01-10-old.md", agentLog({ date: "2026-01-10", status: "completed", task: "Old" }));
    v.write(
      "projects/p.md",
      note({ type: "project", updated: "2026-01-10", title: "P", related: ["- [old log](../agents/tester/reports/2026-01-10-old.md) — touched"] }),
    );
    const plan = planMove(v.root, "agents/tester/reports/2026-01-10-old.md", "agents/tester/reports/archive/2026-01-10-old.md");
    const edit = plan.inbound.find((e) => e.rel === "projects/p.md");
    expect(edit).toBeDefined();
    expect(edit?.linksChanged).toBe(1);
    expect(edit?.text).toContain("[old log](../agents/tester/reports/archive/2026-01-10-old.md)");
  });

  test("a link from a sibling log in the same folder loses nothing but gains archive/", () => {
    v.write("agents/tester/reports/2026-01-10-old.md", agentLog({ date: "2026-01-10", status: "completed", task: "Old" }));
    v.write(
      "agents/tester/reports/2026-01-11-sibling.md",
      agentLog({ date: "2026-01-11", status: "completed", task: "Sibling", related: ["- [old](2026-01-10-old.md) — earlier work"] }),
    );
    const plan = planMove(v.root, "agents/tester/reports/2026-01-10-old.md", "agents/tester/reports/archive/2026-01-10-old.md");
    const edit = plan.inbound.find((e) => e.rel === "agents/tester/reports/2026-01-11-sibling.md");
    expect(edit).toBeDefined();
    expect(edit?.text).toContain("[old](archive/2026-01-10-old.md)");
  });

  test("an edge target naming the old canonical id is rewritten to the new one", () => {
    v.write("agents/tester/reports/2026-01-10-old.md", agentLog({ date: "2026-01-10", status: "completed", task: "Old" }));
    v.write(
      "projects/q.md",
      `---\nupdated: 2026-01-10\ntags: [project]\ntype: project\nedges:\n  - type: evidence-for\n    target: agents/tester/reports/2026-01-10-old\n    context: cites the log\n---\n\n# Q\n\n## Summary\nFixture note.\n\n## Notes\n- n\n\n## Related\n_(none yet)_\n`,
    );
    const plan = planMove(v.root, "agents/tester/reports/2026-01-10-old.md", "agents/tester/reports/archive/2026-01-10-old.md");
    const edit = plan.inbound.find((e) => e.rel === "projects/q.md");
    expect(edit).toBeDefined();
    expect(edit?.edgesChanged).toBe(1);
    expect(edit?.text).toContain("    target: agents/tester/reports/archive/2026-01-10-old\n");
    expect(edit?.text).toContain("    context: cites the log\n");
  });

  test("an unrelated file is byte-identical", () => {
    v.write("agents/tester/reports/2026-01-10-old.md", agentLog({ date: "2026-01-10", status: "completed", task: "Old" }));
    const unrelatedContent = note({ type: "project", updated: "2026-01-10", title: "Unrelated", notes: ["nothing to do with the move"] });
    v.write("projects/unrelated.md", unrelatedContent);
    const plan = planMove(v.root, "agents/tester/reports/2026-01-10-old.md", "agents/tester/reports/archive/2026-01-10-old.md");
    expect(plan.inbound.find((e) => e.rel === "projects/unrelated.md")).toBeUndefined();
    expect(readFileSync(join(v.root, "projects/unrelated.md"), "utf8")).toBe(unrelatedContent);
  });
});

describe("applyMove", () => {
  test("writes every inbound edit, rewrites the moved file, then moves it (plain rename outside a git repo)", () => {
    v.write("agents/tester/reports/2026-01-10-old.md", agentLog({ date: "2026-01-10", status: "completed", task: "Old", related: ["- [AGENTS](../../../AGENTS.md) — protocol"] }));
    v.write(
      "projects/p.md",
      note({ type: "project", updated: "2026-01-10", title: "P", related: ["- [old log](../agents/tester/reports/2026-01-10-old.md) — touched"] }),
    );
    const plan = planMove(v.root, "agents/tester/reports/2026-01-10-old.md", "agents/tester/reports/archive/2026-01-10-old.md");
    applyMove(v.root, plan);

    expect(existsSync(join(v.root, "agents/tester/reports/2026-01-10-old.md"))).toBe(false);
    const moved = readFileSync(join(v.root, "agents/tester/reports/archive/2026-01-10-old.md"), "utf8");
    expect(moved).toContain("[AGENTS](../../../../AGENTS.md)");
    const p = readFileSync(join(v.root, "projects/p.md"), "utf8");
    expect(p).toContain("[old log](../agents/tester/reports/archive/2026-01-10-old.md)");
  });

  test("uses git mv when the vault is a git repo", () => {
    v.write("agents/tester/reports/2026-01-10-old.md", agentLog({ date: "2026-01-10", status: "completed", task: "Old" }));
    Bun.spawnSync(["git", "init", "-q"], { cwd: v.root });
    Bun.spawnSync(["git", "config", "user.email", "t@example.com"], { cwd: v.root });
    Bun.spawnSync(["git", "config", "user.name", "t"], { cwd: v.root });
    Bun.spawnSync(["git", "add", "-A"], { cwd: v.root });
    Bun.spawnSync(["git", "commit", "-q", "-m", "init"], { cwd: v.root });

    const plan = planMove(v.root, "agents/tester/reports/2026-01-10-old.md", "agents/tester/reports/archive/2026-01-10-old.md");
    applyMove(v.root, plan, { git: true });

    const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: v.root }).stdout.toString();
    expect(status).toContain("R  agents/tester/reports/2026-01-10-old.md -> agents/tester/reports/archive/2026-01-10-old.md");
  });

  test("throws when the source file does not exist", () => {
    const plan = planMove(v.root, "agents/tester/reports/does-not-exist.md", "agents/tester/reports/archive/does-not-exist.md");
    expect(plan.outbound).toBeNull();
    expect(() => applyMove(v.root, plan)).toThrow();
  });
});

describe("planMove leaves the vault link-clean end to end", () => {
  test("no broken links after the move, checked with validate-vault's own resolver", () => {
    v.write("AGENTS.md", note({ type: "reference", updated: "2026-01-10", title: "Agent Protocol" }));
    v.write(
      "agents/tester/reports/2026-01-10-old.md",
      agentLog({
        date: "2026-01-10", status: "completed", task: "Old",
        related: ["- [AGENTS](../../../AGENTS.md) — protocol", "- [sibling](other.md) — sibling log"],
      }),
    );
    v.write("agents/tester/reports/other.md", note({ type: "project", updated: "2026-01-10", title: "Other" }));
    v.write(
      "projects/p.md",
      note({ type: "project", updated: "2026-01-10", title: "P", related: ["- [old log](../agents/tester/reports/2026-01-10-old.md) — touched"] }),
    );

    const plan = planMove(v.root, "agents/tester/reports/2026-01-10-old.md", "agents/tester/reports/archive/2026-01-10-old.md");
    applyMove(v.root, plan);

    const report = checkLinks(v.root, buildResolver(v.root));
    expect(report.broken).toEqual([]);
  });
});
