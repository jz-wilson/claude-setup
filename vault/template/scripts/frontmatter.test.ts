import { describe, expect, test } from "bun:test";
import {
  checkBodyPaths,
  checkRetiredWikiLinks,
  extractEdges,
  extractField,
  extractFmLists,
  extractTagsList,
  fmLineNo,
  isValidCalendarDate,
  parseFrontmatter,
  splitLines,
} from "./frontmatter.ts";

const doc = splitLines("---\nupdated: 2026-09-07\ntags: [a, b]\ntype: project\n---\n\n# T\n\n## Notes\n");

describe("parseFrontmatter", () => {
  test("splits frontmatter from body", () => {
    const parsed = parseFrontmatter(doc);
    expect(parsed).not.toBeNull();
    expect(parsed?.fm).toEqual(["updated: 2026-09-07", "tags: [a, b]", "type: project"]);
    expect(parsed?.body[0]).toBe("");
  });

  test("returns null when the file does not start with ---", () => {
    expect(parseFrontmatter(splitLines("# no frontmatter\n"))).toBeNull();
  });

  test("returns null when the closing --- is missing", () => {
    expect(parseFrontmatter(splitLines("---\nupdated: 2026-01-01\n\n# body\n"))).toBeNull();
  });
});

describe("extractField / fmLineNo", () => {
  const fm = parseFrontmatter(doc)?.fm ?? [];
  test("reads a scalar", () => {
    expect(extractField(fm, "type")).toBe("project");
  });
  test("missing field is null", () => {
    expect(extractField(fm, "nope")).toBeNull();
  });
  test("line numbers are 1-based file lines, frontmatter starts at line 2", () => {
    expect(fmLineNo(fm, "type")).toBe(4);
    expect(fmLineNo(fm, "nope", 2, -1)).toBe(-1);
  });
  test("tags list parses inline arrays", () => {
    expect(extractTagsList(fm)).toEqual(["a", "b"]);
  });
});

describe("isValidCalendarDate", () => {
  test("accepts real dates and rejects impossible ones", () => {
    expect(isValidCalendarDate("2026-02-28")).toBe(true);
    expect(isValidCalendarDate("2026-02-30")).toBe(false);
  });
});

describe("splitLines BOM handling", () => {
  test("strips a leading UTF-8 BOM so '---' is seen on line 0", () => {
    const withBom = "﻿---\ntype: infra\nupdated: 2026-09-01\n---\n## Summary\nBody\n";
    const lines = splitLines(withBom);
    expect(lines[0]).toBe("---");
    const parsed = parseFrontmatter(lines);
    expect(parsed).not.toBeNull();
    expect(extractField(parsed!.fm, "type")).toBe("infra");
  });

  test("a file without a BOM is unaffected", () => {
    const lines = splitLines("---\ntype: infra\n---\nbody\n");
    expect(lines[0]).toBe("---");
  });
});

describe("extractFmLists", () => {
  test("parses an inline bracketed list", () => {
    const fm = ["tags: [a, b, c]"];
    expect(extractFmLists(fm)).toEqual(new Map([["tags", ["a", "b", "c"]]]));
  });

  test("parses a YAML block list", () => {
    const fm = ["commits:", "  - abc123", "  - def456", "type: infra"];
    const lists = extractFmLists(fm);
    expect(lists.get("commits")).toEqual(["abc123", "def456"]);
    expect(lists.has("type")).toBe(false); // scalar key, not a list
  });

  test("reads commits:, tags:, and edges: uniformly from one frontmatter block", () => {
    const fm = [
      "tags: [infra, servers]",
      "commits:",
      "  - aaa111",
      "  - bbb222",
      "edges:",
      '  - type: relates-to',
      "    target: infrastructure/nodes",
      '    context: "same rack"',
      "type: infra",
    ];
    const lists = extractFmLists(fm);
    expect(lists.get("tags")).toEqual(["infra", "servers"]);
    expect(lists.get("commits")).toEqual(["aaa111", "bbb222"]);
    expect(lists.get("edges")).toEqual(["type: relates-to"]);
  });

  test("a bracket-less scalar value is not treated as a list", () => {
    const fm = ["type: infra", "updated: 2026-09-01"];
    expect(extractFmLists(fm).size).toBe(0);
  });

  test("empty frontmatter yields an empty map", () => {
    expect(extractFmLists([]).size).toBe(0);
  });
});

describe("extractEdges target validation", () => {
  const edgeFm = (target: string) => [
    "edges:",
    "  - type: depends-on",
    `    target: ${target}`,
    '    context: "test"',
  ];

  test("a bare canonical id is accepted", () => {
    const { edges, errors } = extractEdges(edgeFm("projects/example-app"));
    expect(errors).toEqual([]);
    expect(edges).toEqual([
      expect.objectContaining({ target: "projects/example-app", link: "projects/example-app" }),
    ]);
  });

  test("a quoted [[wiki-link]] target is rejected with the retired-syntax message", () => {
    const { edges, errors } = extractEdges(edgeFm('"[[projects/example-app]]"'));
    expect(edges).toEqual([]);
    expect(errors[0][1]).toBe(
      "edges[0].target uses the retired [[wiki-link]] syntax; write the canonical id (e.g. target: projects/example)",
    );
  });

  test("a target with a .md extension is rejected", () => {
    const { edges, errors } = extractEdges(edgeFm("projects/example-app.md"));
    expect(edges).toEqual([]);
    expect(errors[0][1]).toMatch(/must not include the '\.md' extension/);
  });

  test("a leading-slash target is rejected", () => {
    const { errors } = extractEdges(edgeFm("/projects/example-app"));
    expect(errors[0][1]).toMatch(/must be vault-relative, not an absolute path/);
  });

  test("a target that climbs out of the vault is rejected", () => {
    const { errors } = extractEdges(edgeFm("../projects/example-app"));
    expect(errors[0][1]).toMatch(/must not climb out of the vault/);
  });

  test("a target with a heading anchor is rejected", () => {
    const { errors } = extractEdges(edgeFm("projects/example-app#section"));
    expect(errors[0][1]).toMatch(/must not include a '#' heading anchor/);
  });

  test("a target with an alias is rejected", () => {
    const { errors } = extractEdges(edgeFm('"projects/example-app|Example App"'));
    expect(errors[0][1]).toMatch(/must not include a '\|' alias/);
  });
});

describe("checkRetiredWikiLinks", () => {
  test("flags a [[wiki-link]] in the body with its file line", () => {
    const errs = checkRetiredWikiLinks(["intro", "see [[projects/alpha]] for details"], 10);
    expect(errs).toEqual([[11, "wiki-link syntax is not supported; write [text](relative/path.md)"]]);
  });

  test("ignores [[...]] inside fenced code blocks and inline code", () => {
    const errs = checkRetiredWikiLinks(["```", "[[not/a/link]]", "```", "and `[[also/not]]` inline"], 1);
    expect(errs).toEqual([]);
  });

  test("a clean Markdown-link body has no errors", () => {
    const errs = checkRetiredWikiLinks(["see [Alpha](../projects/alpha.md) for details"], 1);
    expect(errs).toEqual([]);
  });

  test("flags a same-note [[#Heading]] link, which has an empty target (Finding 5)", () => {
    const errs = checkRetiredWikiLinks(["see [[#Setup]] above"], 1);
    expect(errs).toEqual([[1, "wiki-link syntax is not supported; write [text](relative/path.md)"]]);
  });
});

describe("checkBodyPaths", () => {
  test("flags absolute filesystem paths outside code", () => {
    const errs = checkBodyPaths(["see C:\\Users\\x\\file.md", "and file:///tmp/x"], 10);
    expect(errs.length).toBe(2);
    expect(errs[0][0]).toBe(10);
  });
  test("ignores paths inside fenced code blocks and inline code", () => {
    const errs = checkBodyPaths(["```", "cat /mnt/c/x", "```", "run `C:\\tool.exe`"], 1);
    expect(errs).toEqual([]);
  });
});
