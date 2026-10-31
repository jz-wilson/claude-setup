import { describe, expect, test } from "bun:test";
import { blankCode, extractLinks, hrefFor, isExternal, lineIndex, mdLink, resolveHref, slugAnchor, splitHref, vaultLinks, WIKI_LINK_RE } from "./links.ts";

describe("links: extraction", () => {
  const body = [
    "See [nodes](../infrastructure/nodes.md) and [the web](https://example.com \"title\").",
    "An image ![shot](../img/x.png) and `[not](a-link.md)` inline.",
    "```",
    "[fenced](ignored.md)",
    "```",
    "Anchored: [format](<../_format.md#typed-edges>) and bare [top](#summary).",
    "Nested [a [b] c](x.md) and a [[wiki]] leftover.",
  ].join("\n");
  const links = extractLinks(body);
  test("finds links in order with line numbers, skipping code and images", () => {
    expect(links.map((l) => [l.text, l.href, l.line])).toEqual([
      ["nodes", "../infrastructure/nodes.md", 1],
      ["the web", "https://example.com", 1],
      ["format", "../_format.md#typed-edges", 6],
      ["top", "#summary", 6],
      ["a [b] c", "x.md", 7],
    ]);
  });
  test("raw slices come from the original text", () => {
    expect(links[0].raw).toBe("[nodes](../infrastructure/nodes.md)");
    expect(body.slice(links[2].index, links[2].index + links[2].raw.length)).toBe(links[2].raw);
  });
  test("vaultLinks drops external and bare anchors and splits the anchor", () => {
    expect(vaultLinks(body).map((l) => [l.path, l.anchor])).toEqual([
      ["../infrastructure/nodes.md", null],
      ["../_format.md", "typed-edges"],
      ["x.md", null],
    ]);
  });
  test("blankCode keeps offsets and line count", () => {
    const b = blankCode(body);
    expect(b.length).toBe(body.length);
    expect(b.split("\n").length).toBe(body.split("\n").length);
    expect(b).not.toContain("fenced");
    expect(b).not.toContain("not](a-link");
  });
  test("decodes percent-encoded hrefs", () => {
    expect(extractLinks("[x](my%20note.md)")[0].href).toBe("my note.md");
  });
});

describe("links: paths", () => {
  test("isExternal", () => {
    for (const h of ["https://a", "mailto:x@y", "//cdn", "#top", ""]) expect(isExternal(h)).toBe(true);
    for (const h of ["a.md", "../a.md", "dir/a.md", "a.md#x"]) expect(isExternal(h)).toBe(false);
  });
  test("splitHref", () => {
    expect(splitHref("a.md#Heading")).toEqual({ path: "a.md", anchor: "Heading" });
    expect(splitHref("a.md")).toEqual({ path: "a.md", anchor: null });
  });
  test("resolveHref walks relative to the linking file", () => {
    expect(resolveHref("projects/x.md", "../infrastructure/nodes.md")).toBe("infrastructure/nodes.md");
    expect(resolveHref("projects/x.md", "y.md#h")).toBe("projects/y.md");
    expect(resolveHref("AGENTS.md", "docs/agents/setup.md")).toBe("docs/agents/setup.md");
    expect(resolveHref("projects/x.md", "./y.md")).toBe("projects/y.md");
    expect(resolveHref("projects\\x.md", "..\\AGENTS.md".replaceAll("\\", "/"))).toBe("AGENTS.md");
  });
  test("resolveHref refuses escapes, absolutes, externals, and bare anchors", () => {
    expect(resolveHref("projects/x.md", "../../etc/passwd")).toBeNull();
    expect(resolveHref("x.md", "/etc/passwd")).toBeNull();
    expect(resolveHref("x.md", "https://a")).toBeNull();
    expect(resolveHref("x.md", "#top")).toBeNull();
  });
  test("hrefFor is the inverse of resolveHref", () => {
    const cases: [string, string][] = [["projects/x.md", "infrastructure/nodes.md"], ["AGENTS.md", "docs/agents/setup.md"], ["projects/a/b.md", "projects/c.md"], ["projects/x.md", "projects/y.md"], ["x.md", "y.md"]];
    for (const [from, target] of cases) {
      const href = hrefFor(from, target);
      expect(href.startsWith("./")).toBe(false);
      expect(resolveHref(from, href)).toBe(target);
    }
    expect(hrefFor("projects/x.md", "projects/y.md")).toBe("y.md");
    expect(hrefFor("projects/x.md", "AGENTS.md")).toBe("../AGENTS.md");
  });
  test("slugAnchor is GitHub-style", () => {
    expect(slugAnchor("Typed Edges")).toBe("typed-edges");
    expect(slugAnchor("  What to load? (v2) ")).toBe("what-to-load-v2");
  });
  test("slugAnchor keeps underscores and does not collapse runs of spaces", () => {
    expect(slugAnchor("my_heading  two")).toBe("my_heading--two");
    expect(slugAnchor("a___b")).toBe("a___b");
  });
  test("slugAnchor drops punctuation and emoji but keeps Unicode letters/numbers", () => {
    expect(slugAnchor("Héllo, wörld! 2026")).toBe("héllo-wörld-2026");
    expect(slugAnchor("🎉 Party")).toBe("-party");
  });
  test("mdLink writes a relative link and wraps awkward hrefs", () => {
    expect(mdLink("nodes", "projects/x.md", "infrastructure/nodes.md")).toBe("[nodes](../infrastructure/nodes.md)");
    expect(mdLink("f", "x.md", "_format.md", "typed-edges")).toBe("[f](_format.md#typed-edges)");
    expect(mdLink("r", "x.md", "personal/my report.pdf")).toBe("[r](<personal/my report.pdf>)");
    expect(extractLinks(mdLink("a]b", "x.md", "y.md"))[0].text).toBe("a]b");
  });
  test("mdLink escapes a pipe in link text only when escapePipe is set", () => {
    expect(mdLink("a|b", "x.md", "y.md")).toBe("[a|b](y.md)");
    expect(mdLink("a|b", "x.md", "y.md", null, true)).toBe("[a\\|b](y.md)");
  });
  test("escapeLinkText round-trips through extractLinks for tricky titles", () => {
    for (const title of ["C:\\", "Notes [draft", "a]b", "x [y] z", "back\\slash"]) {
      const link = mdLink(title, "x.md", "y.md");
      expect(extractLinks(link)[0].text).toBe(title);
    }
  });
  test("lineIndex.lineOf matches manual line counting", () => {
    const text = "one\ntwo\nthree\n";
    const { lineOf } = lineIndex(text);
    expect(lineOf(0)).toBe(1); // 'o' of "one"
    expect(lineOf(4)).toBe(2); // 't' of "two"
    expect(lineOf(text.indexOf("three"))).toBe(3);
  });
});

describe("WIKI_LINK_RE (retired syntax, kept only to detect/migrate it)", () => {
  const run = (s: string): (string | undefined)[][] => [...s.matchAll(WIKI_LINK_RE)].map((m) => [m[1], m[2], m[3]]);

  test("plain, heading, alias targets", () => {
    expect(run("[[projects/x]]")).toEqual([["projects/x", undefined, undefined]]);
    expect(run("[[projects/x#Some Heading]]")).toEqual([["projects/x", "Some Heading", undefined]]);
    expect(run("[[projects/x|alias]]")).toEqual([["projects/x", undefined, "alias"]]);
  });

  test("an empty target before # matches a same-note link (Finding 5)", () => {
    expect(run("[[#Setup]]")).toEqual([["", "Setup", undefined]]);
    expect(run("[[#Setup|alias]]")).toEqual([["", "Setup", "alias"]]);
  });

  test("a table-escaped alias `\\|` is also a separator, and the backslash is not part of the target (Finding 8)", () => {
    expect(run("[[x\\|alias]]")).toEqual([["x", undefined, "alias"]]);
    expect(run("| a | [[x\\|alias]] | b |")).toEqual([["x", undefined, "alias"]]);
  });
});
