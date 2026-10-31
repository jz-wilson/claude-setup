// Shared test fixture: a throwaway vault in a temp dir, shaped like this one.
// Tests import the exported functions and point them at this root, so the real
// vault is never touched.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { derive, loadConfig, type Derived } from "./config.ts";

export interface FixtureVault {
  root: string;
  d: Derived;
  write(rel: string, content: string): string;
  cleanup(): void;
}

const CONFIG = {
  name: "fixture",
  semantic_dirs: { infra: "infrastructure", project: "projects" },
  episodic_dirs: { decision: "decisions" },
  extra_dirs: [],
  edge_types: [],
};

export function makeVault(): FixtureVault {
  const root = mkdtempSync(join(tmpdir(), "vault-test-"));
  writeFileSync(join(root, "vault.config.json"), JSON.stringify(CONFIG, null, 2));
  for (const dir of ["infrastructure", "projects", "decisions", "agents/tester/reports"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  const d = derive(loadConfig(root));
  return {
    root,
    d,
    write(rel, content) {
      const path = join(root, rel);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, content, "utf8");
      return path;
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function note(opts: { type: string; updated: string; title: string; notes?: string[]; related?: string[] }): string {
  const notes = (opts.notes ?? []).map((n) => `- ${n}`).join("\n");
  const related = (opts.related ?? ["_(none yet)_"]).join("\n");
  return `---\nupdated: ${opts.updated}\ntags: [${opts.type}]\ntype: ${opts.type}\n---\n\n# ${opts.title}\n\n## Summary\nFixture note.\n\n## Notes\n${notes}\n\n## Related\n${related}\n`;
}

/** Completed logs get a `### Verification` section unless `verification: false`. */
export function agentLog(opts: { date: string; status: string; task: string; related?: string[]; extra?: string; verification?: boolean }): string {
  const related = (opts.related ?? ["_(none yet)_"]).join("\n");
  const completed = opts.status === "completed";
  const completion = completed ? "completion_signal: true\nverified: false\n" : "";
  const verification = completed && opts.verification !== false ? "\n### Verification\n- `bun test` -> 3 pass, 0 fail\n" : "";
  return `---\nupdated: ${opts.date}\ntags: [agent-log]\ntype: agent-log\nagent: "tester"\nstatus: ${opts.status}\ntask: "${opts.task}"\npriority: low\ndate: ${opts.date}\n${completion}${opts.extra ?? ""}---\n\n# ${opts.task}\n\n## Summary\nFixture log.\n\n## Notes\n- ${opts.date}: did the thing.\n${verification}\n## Related\n${related}\n`;
}
