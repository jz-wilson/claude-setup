import { expect, test } from "bun:test";
import { chainVerdict, decide, envVerdict, secretVerdict } from "./shell-guard.ts";

const denied = (c: string, tool = "Bash") => expect(secretVerdict(tool, c)).not.toBeNull();
const allowed = (c: string, tool = "Bash") => expect(secretVerdict(tool, c)).toBeNull();

test("secret CLIs that print values are denied", () => {
  for (const c of [
    "gh auth token", "gh auth token --hostname x", "op read op://vault/item/field", "op item get abc",
    "bw get password x", "vault kv get secret/x", "aws secretsmanager get-secret-value --secret-id x",
    "gcloud auth print-access-token", "echo $(gh auth token)", "a && gh auth token", "gh auth token | jq .",
    "bash -c 'gh auth token'", "timeout 5 op read x", "pwsh -Command \"op read x\"",
    "aws --profile dev secretsmanager get-secret-value --secret-id x", "gh --repo a/b auth token", "bw --session abc get password x",
    "gh auth token | cat", 'echo "t=$(gh auth token)"',
  ]) denied(c);
});

test("captured, harmless or merely mentioned forms pass", () => {
  for (const c of [
    "TOKEN=$(gh auth token) curl -H x https://example.com", 'export T="$(op read x)"', "gh auth status", "gh pr list",
    "op whoami", "bw status", "vault status", 'git commit -m "stop running gh auth token"', "echo 'gh auth token'",
    "grep -rn 'op read' .", "gh auth token | docker login ghcr.io -u me --password-stdin", "gh auth token > token.txt",
    "op read op://v/i/key > key.pem", 'curl -H "Authorization: Bearer $(gh auth token)" https://example.com',
    'X=$(curl -H "A: $(gh auth token)" https://example.com)',
  ]) allowed(c);
  allowed("$t = gh auth token", "PowerShell");
  expect(secretVerdict("Read", "gh auth token")).toBeNull();
});

test("secret-looking env vars and bare dumps are denied", () => {
  for (const c of [
    "echo $GITHUB_TOKEN", "echo ${DB_PASSWORD}", "printenv AWS_SECRET_ACCESS_KEY", "printenv", "env", "export -p",
    "echo -n $GITHUB_TOKEN", 'echo -n "$API_KEY"', `echo "it's" $GITHUB_TOKEN "don't"`, 'printf "%s" "$DB_PASSWORD"',
  ])
    expect(envVerdict("Bash", c)).not.toBeNull();
  expect(envVerdict("PowerShell", "echo $env:OPENAI_API_KEY")).not.toBeNull();
  expect(envVerdict("PowerShell", "Get-ChildItem env:")).not.toBeNull();
});

test("PowerShell printers are matched in either case", () => {
  expect(envVerdict("PowerShell", "Write-Host $env:GITHUB_TOKEN")).not.toBeNull();
  expect(envVerdict("PowerShell", "Write-Output $env:DB_PASSWORD")).not.toBeNull();
  expect(envVerdict("PowerShell", "WRITE-HOST $env:GITHUB_TOKEN")).not.toBeNull();
  expect(envVerdict("PowerShell", "write-output $env:GITHUB_TOKEN")).not.toBeNull();
});

test("filtered env use passes", () => {
  for (const c of [
    '[ -n "$GITHUB_TOKEN" ] && echo set', "printenv HOME", "echo $PATH", "env FOO=1 cmd", "set -e", "export FOO=1",
    "echo 'uses $TOKEN later'", 'curl -H "Authorization: Bearer $GITHUB_TOKEN" https://example.com', "echo $token $tokenizer",
    "echo $SESSIONS_DIR_COUNT", "env | grep PATH", "printenv | wc -l",
  ]) expect(envVerdict("Bash", c)).toBeNull();
  expect(envVerdict("PowerShell", "$token = Get-Content f; Write-Host $token")).toBeNull();
  expect(envVerdict("Bash", "cat > f <<'EOF'\nuse $TOKEN here\nEOF")).toBeNull();
});

test("multi-line commit or push needs set -e or &&", () => {
  expect(chainVerdict("Bash", "git add -A\ngit commit -m x")).not.toBeNull();
  expect(chainVerdict("Bash", "cd repo\ngit push")).not.toBeNull();
  expect(chainVerdict("Bash", "set -e\ngit add -A\ngit commit -m x")).toBeNull();
  expect(chainVerdict("Bash", "git add -A &&\ngit commit -m x")).toBeNull();
  expect(chainVerdict("Bash", "git commit -m x")).toBeNull();
  expect(chainVerdict("Bash", "git commit -m \"$(cat <<'EOF'\nline\n\nmore\nEOF\n)\"")).toBeNull();
});

test("decide emits a reason, and fails closed only for secret CLIs", () => {
  expect(decide(JSON.stringify({ tool_name: "Bash", tool_input: { command: "gh auth token" } }))).toContain("gh auth token");
  expect(decide(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }))).toBeNull();
  expect(decide("not json gh auth token")).toContain("denied");
  expect(decide("not json")).toBeNull();
});
