// vault.config.json loader + derived layout. The ONE place dir names are configurable.
import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

// Types always valid regardless of config (the fixed spine + universal note kinds).
const UNIVERSAL_TYPES = ["agent-log", "handoff", "concept", "reference", "glossary", "personal", "skill"];

// Edge types always valid regardless of config — the closed vocabulary in _format.md.
// Mirrors UNIVERSAL_TYPES deliberately: a configured `edge_types` list EXTENDS this set
// rather than replacing it, so a vault whose config has no such key keeps a working vocabulary.
const DEFAULT_EDGE_TYPES = [
  "depends-on", "implements", "supersedes", "contradicts",
  "evidence-for", "part-of", "blocked-by", "about",
];

/** The built-in edge vocabulary as a set, with no config read. For callers that validate a note
 *  without a Derived in hand — they get the closed vocabulary, minus any per-vault extras. */
export const builtinEdgeTypes = (): Set<string> => new Set(DEFAULT_EDGE_TYPES);

// Scaffolding dirs every vault has, independent of preset.
const SCAFFOLD_DIRS = ["agents", "dashboard", "handoffs"];

export interface SnapshotConfig {
  files: string[]; // vault-root-relative paths, each guarded against traversal
  budget_tokens: number;
}

export interface VaultConfig {
  name: string;
  semantic_dirs: Record<string, string>; // type -> dir; deduped notes, distillation target
  episodic_dirs: Record<string, string>; // type -> dir; monthly dated-bullet logs
  extra_dirs: string[]; // freeform spokes, not type-bound
  index_style?: Record<string, string>; // dir name -> rendering style, e.g. "alphabetical"
  snapshot?: SnapshotConfig; // pre-read file set + token budget for agent context priming
  edge_types?: string[]; // EXTRA typed-edge vocabulary, unioned with DEFAULT_EDGE_TYPES
  split_notes_lines?: number; // override for NOTES_SPLIT_LINES (## Notes section split warning threshold)
}

/** Default line-count threshold for the "## Notes section too long, split it" warning
 *  (validate-vault.ts). Overridable per-vault via `split_notes_lines` in vault.config.json. */
export const NOTES_SPLIT_LINES = 150;

export interface Derived {
  cfg: VaultConfig;
  TYPE_DIRS: Record<string, string>; // semantic + episodic merged
  SEMANTIC_DIRS: Record<string, string>;
  EPISODIC_DIRS: Record<string, string>;
  VALID_TYPES: Set<string>;
  EDGE_TYPES: Set<string>;
  ALL_DIRS: string[];
  NOTES_SPLIT_LINES: number;
}

/** Non-content subtrees every vault scanner skips (VCS, deps, editor/tool state, generated/operational dirs).
 *  Tools layer their own intentional extras on top — see search.ts / validate-vault.ts.
 *  A new tool cache dir must be added here, or the validator will lint it. */
export const NONCONTENT_SUBTREES = new Set([".git", "node_modules", ".claude", ".agents", "scripts", "dashboard"]);

/** True if a skip name appears in ANY segment of rel, not just the first — so a repo cloned
 *  into a content dir (projects/x/node_modules/y.md) is skipped like a root-level one. */
export function inSkippedSubtree(rel: string, skip: Set<string>): boolean {
  return rel.split("/").some((seg) => skip.has(seg));
}

/** Bun.Glob and path.relative() emit OS-native separators — backslashes on Windows. Every path
 *  predicate in this repo splits on "/", so a raw result makes inSkippedSubtree/isRestricted
 *  silently no-op on Windows while working on Linux/CI. Normalise once, at the boundary. */
export const toPosix = (p: string) => p.replaceAll("\\", "/");

/** Restricted-content boundary (privacy). Notes under these subtrees, or carrying
 *  `restricted: true` in frontmatter, must never enter retrieval indexes, the typed-edge
 *  graph artifact, or other generated output. The path rule is primary — deterministic
 *  without reading the file; the frontmatter flag extends the boundary to individual
 *  notes living elsewhere. Callers pass forward-slash paths (same contract as
 *  inSkippedSubtree — normalise Bun.Glob/relative() output on Windows first). */
export const RESTRICTED_SUBTREES = new Set(["personal"]);

export function isRestricted(rel: string, noteText?: string): boolean {
  if (inSkippedSubtree(rel, RESTRICTED_SUBTREES)) return true;
  if (!noteText) return false;
  const fm = noteText.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return fm ? /^restricted:\s*(["']?)true\1\s*(#.*)?$/im.test(fm[1]) : false;
}

/** resolve() that refuses to escape base — the canonical traversal guard for anything
 *  user-supplied that becomes a path (config dirs, CLI dir args, snapshot file lists). */
export function resolveInside(base: string, rel: string, label = "path"): string {
  const full = resolve(base, rel);
  if (full !== base && !full.startsWith(base + sep))
    throw new Error(`${label} '${rel}' escapes the vault root`);
  return full;
}

/** Reject any configured dir value that resolves outside vaultRoot (path traversal via vault.config.json). */
function assertInsideVault(vaultRoot: string, label: string, dir: string): void {
  resolveInside(vaultRoot, dir, `vault.config.json: ${label}`);
}

/** Vault dir requested by the caller: explicit `--dir` flag, else $VAULT_DIR, else null.
 *  Callers layer their own local fallback (script parent, cwd) between the two. */
export function requestedVaultDir(argv: string[]): string | null {
  const i = argv.indexOf("--dir");
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return process.env.VAULT_DIR ?? null;
}

/** Run a script entry point, turning any thrown/rejected error into a clean
 *  `error: <msg>` + exit(1) instead of leaking a raw stack trace to the user. */
export function runMain(main: () => unknown): void {
  const die = (e: any): never => {
    console.error(`error: ${e?.message ?? e}`);
    process.exit(1);
  };
  try {
    const r = main();
    if (r instanceof Promise) r.catch(die);
  } catch (e) {
    die(e);
  }
}

export function loadConfig(vaultRoot: string): VaultConfig {
  const raw = JSON.parse(readFileSync(join(vaultRoot, "vault.config.json"), "utf8"));
  const semantic_dirs: Record<string, string> = raw.semantic_dirs ?? {};
  const episodic_dirs: Record<string, string> = raw.episodic_dirs ?? {};
  const extra_dirs: string[] = raw.extra_dirs ?? [];
  const index_style: Record<string, string> | undefined = raw.index_style ?? undefined;
  const snapshot: SnapshotConfig | undefined = raw.snapshot ?? undefined;
  // No assertInsideVault — these are vocabulary strings, never paths.
  const edge_types: string[] | undefined = raw.edge_types ?? undefined;
  const split_notes_lines: number | undefined = raw.split_notes_lines ?? undefined;

  for (const [type, dir] of Object.entries(semantic_dirs)) assertInsideVault(vaultRoot, `semantic_dirs.${type}`, dir);
  for (const [type, dir] of Object.entries(episodic_dirs)) assertInsideVault(vaultRoot, `episodic_dirs.${type}`, dir);
  for (const dir of extra_dirs) assertInsideVault(vaultRoot, "extra_dirs", dir);
  if (snapshot) for (const f of snapshot.files ?? []) assertInsideVault(vaultRoot, "snapshot.files", f);

  const cfg: VaultConfig = { name: raw.name ?? "vault", semantic_dirs, episodic_dirs, extra_dirs };
  if (index_style) cfg.index_style = index_style;
  if (snapshot) cfg.snapshot = snapshot;
  if (edge_types) cfg.edge_types = edge_types;
  if (split_notes_lines !== undefined) cfg.split_notes_lines = split_notes_lines;
  return cfg;
}

export function derive(cfg: VaultConfig): Derived {
  const TYPE_DIRS = { ...cfg.semantic_dirs, ...cfg.episodic_dirs };
  const VALID_TYPES = new Set<string>([...Object.keys(TYPE_DIRS), ...UNIVERSAL_TYPES]);
  const EDGE_TYPES = new Set<string>([...DEFAULT_EDGE_TYPES, ...(cfg.edge_types ?? [])]);
  const ALL_DIRS = [
    ...SCAFFOLD_DIRS,
    ...Object.values(cfg.semantic_dirs),
    ...Object.values(cfg.episodic_dirs),
    ...cfg.extra_dirs,
  ];
  return {
    cfg,
    TYPE_DIRS,
    SEMANTIC_DIRS: cfg.semantic_dirs,
    EPISODIC_DIRS: cfg.episodic_dirs,
    VALID_TYPES,
    EDGE_TYPES,
    ALL_DIRS,
    NOTES_SPLIT_LINES: cfg.split_notes_lines ?? NOTES_SPLIT_LINES,
  };
}

/** Convenience for operational scripts living in <vault>/scripts/. */
export function loadFromScript(importMetaDir: string): Derived {
  const vaultRoot = resolve(importMetaDir, "..");
  return derive(loadConfig(vaultRoot));
}
