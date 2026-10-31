import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateAgentLog } from "./validate-logs.ts";
import { buildResolver, checkLinks, isGitIgnoredLinkTarget, validateVaultNote } from "./validate-vault.ts";
import { agentLog, makeVault, note, type FixtureVault } from "./test-fixture.ts";

let v: FixtureVault;
beforeEach(() => {
  v = makeVault();
});
afterEach(() => {
  v.cleanup();
});

/** A minimal note declaring one `depends-on` edge, for edge-target resolution tests. */
function noteWithEdgeTarget(title: string, target: string): string {
  return [
    "---",
    "updated: 2026-09-01",
    "tags: [project]",
    "type: project",
    "edges:",
    "  - type: depends-on",
    `    target: ${target}`,
    '    context: "test edge"',
    "---",
    "",
    `# ${title}`,
    "",
    "## Summary",
    "x",
    "",
    "## Notes",
    "",
    "## Related",
    "_(none yet)_",
    "",
  ].join("\n");
}

describe("validateVaultNote", () => {
  test("a well-formed semantic note has no errors", () => {
    const path = v.write("projects/alpha.md", note({ type: "project", updated: "2026-09-01", title: "Alpha" }));
    const [rel, errors] = validateVaultNote(path, v.root, v.d.VALID_TYPES, v.d.EDGE_TYPES);
    expect(rel).toBe("projects/alpha.md");
    expect(errors).toEqual([]);
  });

  test("reports an unknown type and a bad date with line numbers", () => {
    const path = v.write("projects/bad.md", "---\nupdated: 2026-13-01\ntags: [x]\ntype: banana\n---\n\n# Bad\n\n## Summary\nx\n\n## Notes\n\n## Related\n_(none yet)_\n");
    const [, errors] = validateVaultNote(path, v.root, v.d.VALID_TYPES, v.d.EDGE_TYPES);
    const messages = errors.map(([, m]) => m).join("\n");
    expect(messages).toMatch(/type/);
    expect(messages).toMatch(/updated/);
    expect(errors.every(([line]) => line >= 1)).toBe(true);
  });

  test("rejects absolute paths in the body", () => {
    const path = v.write("projects/paths.md", note({ type: "project", updated: "2026-09-01", title: "Paths", notes: ["2026-09-01: see C:\\Users\\x\\y.md"] }));
    const [, errors] = validateVaultNote(path, v.root, v.d.VALID_TYPES, v.d.EDGE_TYPES);
    expect(errors.length).toBeGreaterThan(0);
  });

  test("flags a retired [[wiki-link]] in the body with the file line and the standard message", () => {
    const path = v.write("projects/old.md", note({ type: "project", updated: "2026-09-01", title: "Old", notes: ["see [[projects/other]] for background"] }));
    const [, errors] = validateVaultNote(path, v.root, v.d.VALID_TYPES, v.d.EDGE_TYPES);
    const hit = errors.find(([, m]) => m.includes("wiki-link syntax is not supported"));
    expect(hit).toBeDefined();
    expect(hit?.[1]).toBe("wiki-link syntax is not supported; write [text](relative/path.md)");
  });

  test("a retired [[wiki-link]] edge target is a structural error naming the retired syntax", () => {
    const path = v.write("projects/alpha.md", noteWithEdgeTarget("Alpha", '"[[projects/beta]]"'));
    const [, errors] = validateVaultNote(path, v.root, v.d.VALID_TYPES, v.d.EDGE_TYPES);
    expect(errors.some(([, m]) => m.includes("uses the retired [[wiki-link]] syntax"))).toBe(true);
  });

  test("an edge target carrying a .md extension is a structural error", () => {
    const path = v.write("projects/alpha.md", noteWithEdgeTarget("Alpha", "projects/beta.md"));
    const [, errors] = validateVaultNote(path, v.root, v.d.VALID_TYPES, v.d.EDGE_TYPES);
    expect(errors.some(([, m]) => m.includes("must not include the '.md' extension"))).toBe(true);
  });
});

describe("checkLinks — body links resolve relative to the linking note", () => {
  test("a same-folder link resolves", () => {
    v.write("projects/alpha.md", note({ type: "project", updated: "2026-09-01", title: "Alpha", notes: ["see [Beta](beta.md)"] }));
    v.write("projects/beta.md", note({ type: "project", updated: "2026-09-01", title: "Beta" }));
    expect(checkLinks(v.root).broken).toEqual([]);
  });

  test("a link from a subfolder up to a root-level note resolves", () => {
    v.write("projects/sub/child.md", note({ type: "project", updated: "2026-09-01", title: "Child", notes: ["see [Glossary](../../glossary.md)"] }));
    v.write("glossary.md", note({ type: "project", updated: "2026-09-01", title: "Glossary" }));
    expect(checkLinks(v.root).broken).toEqual([]);
  });

  test("a heading anchor does not affect resolution", () => {
    v.write("projects/alpha.md", note({ type: "project", updated: "2026-09-01", title: "Alpha", notes: ["see [Beta](beta.md#some-heading)"] }));
    v.write("projects/beta.md", note({ type: "project", updated: "2026-09-01", title: "Beta" }));
    expect(checkLinks(v.root).broken).toEqual([]);
  });

  test("an attachment link resolves against a non-.md file", () => {
    v.write("projects/alpha.md", note({ type: "project", updated: "2026-09-01", title: "Alpha", notes: ["see [Report](report.pdf)"] }));
    v.write("projects/report.pdf", "not a real pdf, just bytes for the test");
    expect(checkLinks(v.root).broken).toEqual([]);
  });

  test("a link to a missing file is broken", () => {
    v.write("projects/alpha.md", note({ type: "project", updated: "2026-09-01", title: "Alpha", notes: ["see [Ghost](ghost.md)"] }));
    const { broken } = checkLinks(v.root);
    expect(broken.map(([, , m]) => m)).toEqual(["broken link [Ghost](ghost.md) — no file at projects/ghost.md"]);
  });

  test("a case-mismatched link is broken (resolution is case-sensitive)", () => {
    v.write("projects/alpha.md", note({ type: "project", updated: "2026-09-01", title: "Alpha", notes: ["see [Beta](Beta.md)"] }));
    v.write("projects/beta.md", note({ type: "project", updated: "2026-09-01", title: "Beta" })); // lowercase on disk
    const { broken } = checkLinks(v.root);
    expect(broken.map(([, , m]) => m)).toEqual(["broken link [Beta](Beta.md) — no file at projects/Beta.md"]);
  });

  test("a link that climbs above the vault root is broken", () => {
    v.write("projects/alpha.md", note({ type: "project", updated: "2026-09-01", title: "Alpha", notes: ["see [Outside](../../../etc/passwd.md)"] }));
    const { broken } = checkLinks(v.root);
    expect(broken.map(([, , m]) => m)).toEqual(["broken link [Outside](../../../etc/passwd.md) — escapes the vault"]);
  });

  test("a vault-root-absolute link is broken", () => {
    v.write("projects/alpha.md", note({ type: "project", updated: "2026-09-01", title: "Alpha", notes: ["see [Abs](/projects/beta.md)"] }));
    v.write("projects/beta.md", note({ type: "project", updated: "2026-09-01", title: "Beta" }));
    const { broken } = checkLinks(v.root);
    expect(broken.map(([, , m]) => m)).toEqual(["broken link [Abs](/projects/beta.md) — absolute paths are not allowed"]);
  });

  test("a link into a dot-directory resolves (Finding 2)", () => {
    v.write(".claude/skills/vault-eval/SKILL.md", note({ type: "project", updated: "2026-09-01", title: "Skill" }));
    v.write("projects/alpha.md", note({ type: "project", updated: "2026-09-01", title: "Alpha", notes: ["see [Skill](../.claude/skills/vault-eval/SKILL.md)"] }));
    expect(checkLinks(v.root).broken).toEqual([]);
  });

  test("buildResolver indexes dot-directories but never .git internals", () => {
    v.write(".github/workflows/x.yml", "name: x\n");
    v.write(".git/HEAD", "ref: refs/heads/main\n");
    const resolver = buildResolver(v.root);
    expect(resolver.exists(".github/workflows/x.yml", "AGENTS.md")).toBe(true);
    expect(resolver.exists(".git/HEAD", "AGENTS.md")).toBe(false);
  });

  test("a note under .claude/ is not linted as a schema source (linting scope does not widen)", () => {
    // A note failing every schema rule (no frontmatter at all) would fail validateVaultNote if
    // checked, but shouldSkip/skipForEdges exclude .claude/ from the source scan — only the
    // resolver's existence index widened (Finding 2), not what gets linted.
    v.write(".claude/skills/x/SKILL.md", "not even frontmatter\n");
    const broken = checkLinks(v.root).broken;
    expect(broken.some(([rel]) => rel.startsWith(".claude/"))).toBe(false);
  });

  test("a directory link (trailing slash) resolves when the directory exists (Finding 3)", () => {
    v.write("projects/sub/child.md", note({ type: "project", updated: "2026-09-01", title: "Child" }));
    v.write("projects/alpha.md", note({ type: "project", updated: "2026-09-01", title: "Alpha", notes: ["see [Sub](sub/)"] }));
    expect(checkLinks(v.root).broken).toEqual([]);
  });

  test("a directory link with no trailing slash resolves when the directory exists (Finding 3)", () => {
    v.write("scripts/x.md", note({ type: "project", updated: "2026-09-01", title: "X" }));
    v.write("projects/alpha.md", note({ type: "project", updated: "2026-09-01", title: "Alpha", notes: ["see [scripts](../scripts)"] }));
    expect(checkLinks(v.root).broken).toEqual([]);
  });

  test("a directory link to a directory that does not exist is broken", () => {
    v.write("projects/alpha.md", note({ type: "project", updated: "2026-09-01", title: "Alpha", notes: ["see [Ghost](ghost-dir/)"] }));
    const { broken } = checkLinks(v.root);
    expect(broken.map(([, , m]) => m)).toEqual(["broken link [Ghost](ghost-dir/) — no file at projects/ghost-dir/"]);
  });

  test("an extensionless attachment link resolves against the exact file (Finding 3)", () => {
    v.write("projects/alpha.md", note({ type: "project", updated: "2026-09-01", title: "Alpha", notes: ["see [LICENSE](../LICENSE)"] }));
    v.write("LICENSE", "MIT\n");
    expect(checkLinks(v.root).broken).toEqual([]);
  });

  test("links inside fenced code blocks are ignored", () => {
    v.write(
      "projects/alpha.md",
      "---\nupdated: 2026-09-01\ntags: [project]\ntype: project\n---\n\n# Alpha\n\n## Summary\nx\n\n## Notes\n```\n[Ghost](nope.md)\n```\n\n## Related\n_(none yet)_\n",
    );
    expect(checkLinks(v.root).broken).toEqual([]);
  });
});

describe("checkLinks — edge targets", () => {
  test("a bare canonical id edge target resolves", () => {
    v.write("projects/alpha.md", noteWithEdgeTarget("Alpha", "projects/beta"));
    v.write("projects/beta.md", note({ type: "project", updated: "2026-09-01", title: "Beta" }));
    expect(checkLinks(v.root).broken).toEqual([]);
  });

  test("an edge target with no matching note is broken", () => {
    v.write("projects/alpha.md", noteWithEdgeTarget("Alpha", "projects/ghost"));
    const { broken } = checkLinks(v.root);
    expect(broken.map(([, , m]) => m)).toEqual(["broken edge target projects/ghost — no matching note"]);
  });
});

describe("checkLinks and gitignored targets", () => {
  const gitInit = () => {
    const r = Bun.spawnSync(["git", "init", "-q"], { cwd: v.root, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
  };

  test("a link to a gitignored machine-local note is not broken even when the file is absent", () => {
    gitInit();
    v.write(".gitignore", "/SYSTEM.md\npersonal/**\n!personal/**/\n!personal/*.md\n!personal/**/*.md\n");
    v.write("projects/alpha.md", note({ type: "project", updated: "2026-09-01", title: "Alpha", related: ["- [SYSTEM](../SYSTEM.md) — machine facts"] }));
    v.write("personal/jobs/app.md", note({ type: "project", updated: "2026-09-01", title: "App", related: ["- [Resume](Resume.pdf) — attachment"] }));
    // Body-link call shape: checkLinks passes the already-resolved vault-relative path with sourceRel "".
    expect(isGitIgnoredLinkTarget(v.root, "", "SYSTEM.md")).toBe(true);
    expect(isGitIgnoredLinkTarget(v.root, "", "personal/jobs/Resume.pdf")).toBe(true);
    expect(isGitIgnoredLinkTarget(v.root, "", "ghost.md")).toBe(false);
    // Edge-target call shape: a bare canonical id plus the linking note's directory.
    expect(isGitIgnoredLinkTarget(v.root, "projects/alpha.md", "SYSTEM")).toBe(true);
    expect(checkLinks(v.root).broken).toEqual([]);
  });

  test("a gitignored directory target is not given a bogus '.md' extension (Finding 3)", () => {
    gitInit();
    v.write(".gitignore", "personal/private/\n");
    // Body-link shape (sourceRel ""): the resolved path already carries its real form — a
    // directory link ends in '/', not '/.md'.
    expect(isGitIgnoredLinkTarget(v.root, "", "personal/private/")).toBe(true);
    v.write("projects/alpha.md", note({ type: "project", updated: "2026-09-01", title: "Alpha", notes: ["see [Private](../personal/private/)"] }));
    expect(checkLinks(v.root).broken).toEqual([]);
  });

  test("without an ignore rule the same links are broken", () => {
    gitInit();
    v.write("projects/alpha.md", note({ type: "project", updated: "2026-09-01", title: "Alpha", related: ["- [SYSTEM](../SYSTEM.md) — machine facts"] }));
    expect(checkLinks(v.root).broken.length).toBe(1);
  });
});

describe("validateAgentLog", () => {
  test("a schema-compliant completed log has no errors", () => {
    const path = v.write("agents/tester/reports/2026-09-01-good.md", agentLog({ date: "2026-09-01", status: "completed", task: "Good" }));
    const [, errors] = validateAgentLog(path, v.root, v.d.EDGE_TYPES);
    expect(errors).toEqual([]);
  });

  test("status error requires error_class and an Error Log section", () => {
    const path = v.write("agents/tester/reports/2026-09-01-broken.md", agentLog({ date: "2026-09-01", status: "error", task: "Broken" }));
    const [, errors] = validateAgentLog(path, v.root, v.d.EDGE_TYPES);
    const messages = errors.map(([, m]) => m).join("\n");
    expect(messages).toMatch(/error_class/);
    expect(messages).toMatch(/Error Log/);
  });

  test("status completed requires completion_signal: true on live logs only", () => {
    const text = agentLog({ date: "2026-09-01", status: "completed", task: "No signal" }).replace("completion_signal: true\n", "");
    const live = v.write("agents/tester/reports/2026-09-01-nosig.md", text);
    const [, errors] = validateAgentLog(live, v.root, v.d.EDGE_TYPES);
    expect(errors.map(([, m]) => m).join("\n")).toMatch(/completion_signal' is not true/);
    const archived = v.write("agents/tester/reports/archive/2026-09-01-nosig.md", text);
    expect(validateAgentLog(archived, v.root, v.d.EDGE_TYPES)[1]).toEqual([]);
    for (const val of ["false", "yes"]) {
      const p = v.write(`agents/tester/reports/2026-09-01-sig-${val}.md`, text.replace("verified: false", `completion_signal: ${val}\nverified: false`));
      expect(validateAgentLog(p, v.root, v.d.EDGE_TYPES)[1].map(([, m]) => m).join("\n")).toMatch(/is not true/);
    }
  });

  test("completed logs need verified: and a non-empty ### Verification under ## Notes", () => {
    const base = agentLog({ date: "2026-10-13", status: "completed", task: "Gated", verification: false });
    const msgs = (name: string, text: string) =>
      validateAgentLog(v.write(`agents/tester/reports/2026-10-13-${name}.md`, text), v.root, v.d.EDGE_TYPES)[1].map(([, m]) => m).join("\n");
    expect(msgs("noevidence", base)).toMatch(/### Verification/);
    expect(msgs("placeholder", base.replace("## Related", "### Verification\n\n_(none yet)_\n\n## Related"))).toMatch(/### Verification/);
    expect(msgs("outside", base.replace("## Related", "## Extra\n### Verification\n- ran it\n\n## Related"))).toMatch(/### Verification/);
    expect(msgs("evidence", base.replace("## Related", "### Verification\n\n- `bun test` -> 12 pass, 0 fail\n\n## Related"))).toBe("");
    expect(msgs("fenced", base.replace("## Related", "### Verification\n~~~\nok\n~~~\n\n## Related"))).toBe("");
    expect(msgs("noverified", agentLog({ date: "2026-10-13", status: "completed", task: "X" }).replace("verified: false\n", ""))).toMatch(/'verified' field is missing/);
  });

  test("filename must match YYYY-MM-DD-slug.md", () => {
    const path = v.write("agents/tester/reports/badname.md", agentLog({ date: "2026-09-01", status: "active", task: "Bad name" }));
    const [, errors] = validateAgentLog(path, v.root, v.d.EDGE_TYPES);
    expect(errors.map(([, m]) => m).join("\n")).toMatch(/filename/);
  });

  test("flags a retired [[wiki-link]] in the body", () => {
    const path = v.write(
      "agents/tester/reports/2026-09-01-old.md",
      agentLog({ date: "2026-09-01", status: "completed", task: "Old", related: ["- see [[projects/alpha]]"] }),
    );
    const [, errors] = validateAgentLog(path, v.root, v.d.EDGE_TYPES);
    expect(errors.some(([, m]) => m.includes("wiki-link syntax is not supported"))).toBe(true);
  });
});

// Rules carried over from the first template validator and its review.
describe("validateAgentLog: template rules", () => {
  let v: FixtureVault;
  beforeEach(() => { v = makeVault(); });
  afterEach(() => v.cleanup());
  const msgs = (name: string, text: string) =>
    validateAgentLog(v.write(`agents/tester/reports/2026-10-01-${name}.md`, text), v.root, v.d.EDGE_TYPES)[1].map(([, m]) => m).join("\n");
  const log = (o: Partial<Parameters<typeof agentLog>[0]> = {}) => agentLog({ date: "2026-10-01", status: "active", task: "T", ...o });

  test("inline YAML comments are ignored", () => {
    expect(msgs("comment", log().replace("status: active", "status: active   # still going").replace("priority: low", "priority: low # meh"))).toBe("");
  });
  test("block-list tags work, and a tag that only contains agent-log does not count", () => {
    expect(msgs("block", log().replace("tags: [agent-log]", "tags:\n  - agent-log\n  - extra"))).toBe("");
    expect(msgs("substr", log().replace("tags: [agent-log]", "tags: [not-agent-log]"))).toMatch(/must contain 'agent-log'/);
  });
  test("exactly one H1 and the three sections in order", () => {
    expect(msgs("twoh1", log().replace("## Summary", "# Second\n\n## Summary"))).toMatch(/exactly one H1/);
    expect(msgs("order", log().replace("## Summary\nFixture log.\n\n## Notes", "## Notes\nx\n\n## Summary"))).toMatch(/in that order/);
    expect(msgs("fenced-h1", log().replace("## Notes\n", "## Notes\n~~~\n# not a heading\n~~~\n"))).toBe("");
  });
  test("status error needs error_class and an H2 Error Log, not an H3", () => {
    const err = log({ status: "error", extra: "error_class: transient\n" });
    expect(msgs("h3", err.replace("## Related", "### Error Log\n- boom\n\n## Related"))).toMatch(/Error Log/);
    expect(msgs("h2", err.replace("## Related", "## Error Log\n- boom\n\n## Related"))).toBe("");
  });
  test("absolute paths are refused outside code, allowed inside it", () => {
    for (const p of ["/Users/me/x.md", "/home/me/x.md", "D:\\notes\\x.md", "\\\\server\\share", "file:///tmp/x"])
      expect(msgs("abs", log().replace("did the thing.", `see ${p}`))).toMatch(/absolute|file:\/\//);
    expect(msgs("code", log().replace("did the thing.", "see `/home/me/x.md`"))).toBe("");
  });
});

describe("validate-logs --hook", () => {
  const script = join(import.meta.dir, "validate-logs.ts");
  const run = (filePath: string) =>
    Bun.spawnSync(["bun", script, "--hook"], { stdin: Buffer.from(JSON.stringify({ tool_input: { file_path: filePath } })) });
  test("exits 0 for a file that is not an agent log", () => {
    expect(run(join(import.meta.dir, "..", "_format.md")).exitCode).toBe(0);
  });
  test("exits 2 with errors for a broken log", () => {
    const dir = join(import.meta.dir, "..", "agents", "hook-test", "reports");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "2026-10-01-broken.md");
    writeFileSync(path, "---\ntype: agent-log\n---\n\nno heading\n");
    try {
      const r = run(path);
      expect(r.exitCode).toBe(2);
      expect(r.stderr.toString()).toContain("missing required frontmatter field");
    } finally {
      rmSync(join(import.meta.dir, "..", "agents", "hook-test"), { recursive: true, force: true });
    }
  });
});
