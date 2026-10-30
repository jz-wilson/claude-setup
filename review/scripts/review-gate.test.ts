import { expect, test } from "bun:test";
import { needsReview } from "./review-gate.ts";

const tool = (name: string, input: Record<string, unknown>) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
const typed = (text: string) => JSON.stringify({ type: "user", message: { content: text } });
const run = (...lines: string[]) => needsReview(lines.join("\n"));

test("no edits passes", () => expect(run(tool("Read", { file_path: "a.ts" }))).toBeNull());
test("markdown-only edits pass", () => expect(run(tool("Edit", { file_path: "notes/a.md" }))).toBeNull());
test("scratchpad code edits pass", () =>
  expect(run(tool("Write", { file_path: "C:\\Users\\x\\AppData\\Local\\Temp\\claude\\s\\scratchpad\\t.ts" }))).toBeNull());
test("code edit without review blocks", () => expect(run(tool("Edit", { file_path: "src/a.ts" }))).toBe("src/a.ts"));
test("yaml edit without review blocks", () => expect(run(tool("Write", { file_path: "k8s/app.yaml" }))).toBe("k8s/app.yaml"));
test("code-review skill after edit passes", () =>
  expect(run(tool("Edit", { file_path: "a.py" }), tool("Skill", { skill: "code-review" }))).toBeNull());
test("typed /code-review after edit passes", () =>
  expect(run(tool("Edit", { file_path: "a.py" }), typed("<command-name>/code-review</command-name>"))).toBeNull());
test("a tool result echoing /code-review does not count", () =>
  expect(run(tool("Edit", { file_path: "a.py" }), JSON.stringify({ type: "user", message: { content: [
    { type: "tool_result", content: "<command-name>/code-review</command-name>" }] } }))).toBe("a.py"));
test("reviewer subagent after edit passes", () =>
  expect(run(tool("Edit", { file_path: "a.go" }), tool("Agent", { prompt: "Review this diff against the requirements" }))).toBeNull());
test("review before the first edit does not count", () =>
  expect(run(tool("Skill", { skill: "code-review" }), tool("Edit", { file_path: "a.go" }))).toBe("a.go"));
test("a subagent that merely mentions review does not count", () =>
  expect(run(tool("Edit", { file_path: "a.ts" }), tool("Agent", { prompt: "Find where PR review comments are handled" }))).toBe("a.ts"));
test("non-review subagent does not count", () =>
  expect(run(tool("Edit", { file_path: "a.sh" }), tool("Agent", { prompt: "Find the config loader" }))).toBe("a.sh"));
test("a torn last line is skipped", () => expect(run(tool("Edit", { file_path: "a.ts" }), '{"type":"assist')).toBe("a.ts"));
