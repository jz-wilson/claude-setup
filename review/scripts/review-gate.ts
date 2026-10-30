// Stop hook: a session that edited code must get an independent review before it ends.
// Blocks once (exit 2) when the transcript has an Edit/Write/MultiEdit/NotebookEdit on a code
// file and no review after the first such edit: /code-review (skill or typed command), or an
// Agent/Task/Workflow call whose prompt mentions a review. stop_hook_active lets the second stop
// through, so a session that declines to review is nagged once, never looped. REVIEW_GATE=0 disables.
import { readFileSync } from "node:fs";

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|sh|ps1|psm1|java|kt|rb|cs|c|cc|cpp|h|hpp|lua|sql|ya?ml|tf|hcl)$/i;
const SCRATCH = /[\\/](scratchpad|Temp|tmp)[\\/]/i;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const REVIEW_TOOLS = new Set(["Agent", "Task", "Workflow"]);

type ToolUse = { type: string; name?: string; input?: Record<string, unknown>; text?: string };

const typedText = (content: unknown): string =>
  typeof content === "string" ? content
    : Array.isArray(content) ? (content as ToolUse[]).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n")
    : "";

// "Review" alone is too loose ("find where PR review comments are handled"); it must name the change.
const isReviewPrompt = (text: string) =>
  /code[- ]review|\breviewer\b/i.test(text) || (/\breview/i.test(text) && /\b(diff|correctness|changes?)\b/i.test(text));

export function needsReview(transcript: string): string | null {
  let firstEdit: string | null = null;
  for (const line of transcript.split("\n")) {
    if (!line.includes('"tool_use"') && !line.includes("command-name")) continue; // skip parsing most lines
    let entry: { type?: string; message?: { content?: unknown } };
    try { entry = JSON.parse(line); } catch { continue; } // a partially flushed last line
    const content = entry.message?.content;
    // Only text the user typed counts; a tool result can echo the same words (a test fixture, a grep).
    if (firstEdit && entry.type === "user" && typedText(content).includes("<command-name>/code-review")) return null;
    if (entry.type !== "assistant" || !Array.isArray(content)) continue;
    for (const block of content as ToolUse[]) {
      if (block.type !== "tool_use" || !block.name) continue;
      const input = block.input ?? {};
      if (EDIT_TOOLS.has(block.name)) {
        const path = String(input.file_path ?? input.notebook_path ?? "");
        if (!firstEdit && CODE_EXT.test(path) && !SCRATCH.test(path)) firstEdit = path;
      } else if (firstEdit && block.name === "Skill" && /(^|:)code-review\b/.test(String(input.skill ?? ""))) {
        return null;
      } else if (firstEdit && REVIEW_TOOLS.has(block.name) && isReviewPrompt(`${input.prompt ?? ""}\n${input.script ?? ""}`)) {
        return null;
      }
    }
  }
  return firstEdit;
}

if (import.meta.main) {
  if (process.env.REVIEW_GATE === "0") process.exit(0);
  const payload = JSON.parse(await Bun.stdin.text());
  if (payload.stop_hook_active) process.exit(0);
  const edited = needsReview(readFileSync(payload.transcript_path, "utf8"));
  if (edited) {
    process.stderr.write(
      `review-gate: this session edited code (first: ${edited}) and has no independent review. ` +
      `Run /code-review, or a reviewer subagent given only the diff and the requirements; fix correctness findings ` +
      `and record them in the log. If the edit needs no review (a trivial one-liner), say why and stop again.\n`,
    );
    process.exit(2);
  }
}
