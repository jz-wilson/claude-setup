import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createNote, insertBullet, resolvePath, ymd } from "./capture.ts";
import { validateVaultNote } from "./validate-vault.ts";
import { makeVault, note, type FixtureVault } from "./test-fixture.ts";

let v: FixtureVault;
const today = new Date(2026, 8, 7); // 2026-09-07 local time

beforeEach(() => {
  v = makeVault();
});
afterEach(() => {
  v.cleanup();
});

describe("resolvePath", () => {
  test("semantic type resolves to <dir>/<note>.md", () => {
    expect(resolvePath(v.d, v.root, "project", "alpha", today)).toBe(join(v.root, "projects", "alpha.md"));
  });
  test("episodic type resolves to the monthly file and ignores --note", () => {
    expect(resolvePath(v.d, v.root, "decision", "", today)).toBe(join(v.root, "decisions", "2026-09.md"));
  });
  test("rejects path separators in --note", () => {
    expect(() => resolvePath(v.d, v.root, "project", "../escape", today)).toThrow(/plain filename/);
  });
  test("rejects unknown types", () => {
    expect(() => resolvePath(v.d, v.root, "banana", "x", today)).toThrow(/unsupported type/);
  });
});

describe("insertBullet", () => {
  test("appends a dated bullet under ## Notes, bumps updated:, and the result passes the validator", () => {
    const path = v.write("projects/alpha.md", note({ type: "project", updated: "2026-01-01", title: "Alpha", notes: ["2026-01-01: first"] }));
    insertBullet(path, "shipped v2", today, v.root, v.d.VALID_TYPES, v.d.EDGE_TYPES);
    const text = readFileSync(path, "utf8");
    expect(text).toContain(`updated: ${ymd(today)}`);
    expect(text).toContain("- 2026-01-01: first\n- 2026-09-07: shipped v2\n\n## Related");
    const [, errors] = validateVaultNote(path, v.root, v.d.VALID_TYPES, v.d.EDGE_TYPES);
    expect(errors).toEqual([]);
  });

  test("adds an updated: field when the note lacks one", () => {
    const path = v.write("projects/beta.md", "---\ntags: [project]\ntype: project\n---\n\n# Beta\n\n## Summary\nx\n\n## Notes\n\n## Related\n_(none yet)_\n");
    insertBullet(path, "fact", today, v.root, v.d.VALID_TYPES, v.d.EDGE_TYPES);
    expect(readFileSync(path, "utf8").startsWith(`---\nupdated: ${ymd(today)}\n`)).toBe(true);
  });

  test("restores the original file when the validator rejects the result", () => {
    // A fact carrying an absolute path is rejected by checkBodyPaths.
    const original = note({ type: "project", updated: "2026-01-01", title: "Gamma" });
    const path = v.write("projects/gamma.md", original);
    expect(() => insertBullet(path, "see C:\\Users\\x\\y.md", today, v.root, v.d.VALID_TYPES, v.d.EDGE_TYPES)).toThrow(/validator rejected/);
    expect(readFileSync(path, "utf8")).toBe(original);
  });
});

describe("createNote", () => {
  test("creates a validator-clean skeleton for a new semantic note", () => {
    const path = resolvePath(v.d, v.root, "infra", "new-node", today);
    expect(existsSync(path)).toBe(false);
    createNote(v.d, path, "infra", "new-node", today);
    const [, errors] = validateVaultNote(path, v.root, v.d.VALID_TYPES, v.d.EDGE_TYPES);
    expect(errors).toEqual([]);
    expect(readFileSync(path, "utf8")).toContain("# New Node");
  });
});
