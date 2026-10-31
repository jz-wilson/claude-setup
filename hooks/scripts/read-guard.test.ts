import { expect, test } from "bun:test";
import { decide, readVerdict } from "./read-guard.ts";

const deny = (c: string) => expect(readVerdict("Bash", c)).not.toBeNull();
const allow = (c: string) => expect(readVerdict("Bash", c)).toBeNull();

test("whole-file and ranged shell reads are denied", () => {
  deny("cat big.md");
  deny("cat a.md b.md");
  deny("head -n 50 notes/x.md");
  deny("tail -20 log.txt");
  deny("sed -n '1,40p' src/app.ts");
  deny("cd repo && cat README.md");
  deny("bash -c 'cat secrets.txt'");
  deny("cat < input.txt"); // still prints the file
  deny("echo start; cat config.json");
});

test("redirects, pipes, edits, follows, stdin and remote reads pass", () => {
  allow("cat a > b");
  allow("cat a >> b");
  allow("cat part1 part2 > whole");
  allow("cat big.md | grep TODO");
  allow("git log --oneline | head -5");
  allow("ps aux | tail -n 3");
  allow("sed -i 's/a/b/' file.txt");
  allow("tail -f server.log");
  allow("ssh host cat /etc/hostname");
  allow("echo cat file.md");
  allow("git commit -m 'cat README.md'");
  allow("cat");
  allow("sed -Ei 's/a/b/' f");
  allow("sed -ri 's/a/b/' f");
  allow('cat <<< "$x"');
  allow('head -n1 <<< "$x"');
  allow("cat <(git log)");
  allow("cat f &>/dev/null");
});

test("only Bash is guarded, and a bad payload is let through", () => {
  expect(readVerdict("PowerShell", "cat big.md")).toBeNull();
  expect(decide("not json")).toBeNull();
  expect(decide(JSON.stringify({ tool_name: "Bash", tool_input: { command: "cat big.md" } }))).toContain("Read tool");
});
