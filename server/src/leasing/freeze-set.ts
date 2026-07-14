/**
 * Freeze-set computation — the 1-hop reverse blast radius of an agent's edits.
 *
 * Deterministic, no LLM: `git diff` tells us which functions changed, `ctags`
 * (universal-ctags, JSON) gives function line-ranges, and `git grep` finds the
 * call sites; the enclosing function of each call site is a "caller." The freeze
 * set = {edited functions} ∪ {their callers}. Approximate on purpose — over-freeze
 * is safe, under-freeze is caught by tests (see the design discussion). Callees /
 * bidirectional / deeper hops are deliberate follow-ups.
 *
 * Pure helpers (parseCtags, enclosingFunction, parseDiffChangedLines, buildFreezeSet)
 * are separated from the shell-outs so they unit-test without ctags/git present.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";

const execFileAsync = promisify(execFile);

// Source globs for caller-grep — language-general (Scylla core is C++, but the
// agent workloads are Elixir/Python/JS + more). Over-matching a name in an
// unrelated file is over-freeze, which is safe by design.
const SOURCE_GLOBS = [
  "*.cc", "*.cpp", "*.cxx", "*.hh", "*.hpp", "*.h", "*.c",
  "*.ex", "*.exs", "*.py", "*.rb", "*.go", "*.rs", "*.java",
  "*.js", "*.jsx", "*.ts", "*.tsx",
];
// ctags function-ish kinds across languages: C/C++ (function/method/prototype),
// Elixir/Python/JS (function), Python/Ruby methods (member/singletonMethod), Go (func).
const FUNC_KINDS = new Set(["function", "method", "prototype", "member", "singletonMethod", "func"]);
const MAX_GREP_HITS = 300; // names hotter than this over-freeze the world — cap it

export interface CtagsSymbol {
  name: string;
  file: string;
  start: number;
  end: number;
  kind: string;
}

// ── Pure helpers ───────────────────────────────────────────

/** Parse universal-ctags `--output-format=json --fields=+ne` (one JSON obj/line).
 *  Some parsers (notably Elixir) don't emit an end-line for functions — for those
 *  we SYNTHESIZE the range as [start, next-symbol.start − 1] within the file (last
 *  symbol runs to EOF). Over-extending to the next def is over-freeze = safe. */
export function parseCtags(jsonl: string): CtagsSymbol[] {
  const out: Array<CtagsSymbol & { _endGiven: boolean }> = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let t: { _type?: string; name?: string; path?: string; kind?: string; line?: number; end?: number };
    try {
      t = JSON.parse(line);
    } catch {
      continue;
    }
    if (t._type !== "tag" || !t.name || !t.path || !t.kind || !FUNC_KINDS.has(t.kind)) continue;
    if (typeof t.line !== "number") continue;
    const endGiven = typeof t.end === "number" && t.end > t.line;
    out.push({ name: t.name, file: t.path, kind: t.kind, start: t.line, end: endGiven ? t.end! : t.line, _endGiven: endGiven });
  }
  // Fill missing/degenerate end-lines from the next symbol's start, per file.
  const byFile = new Map<string, Array<CtagsSymbol & { _endGiven: boolean }>>();
  for (const s of out) {
    const arr = byFile.get(s.file);
    if (arr) arr.push(s); else byFile.set(s.file, [s]);
  }
  for (const syms of byFile.values()) {
    syms.sort((a, b) => a.start - b.start);
    for (let i = 0; i < syms.length; i++) {
      if (syms[i]._endGiven) continue;
      const next = syms.slice(i + 1).find((s) => s.start > syms[i].start);
      syms[i].end = next ? next.start - 1 : Number.MAX_SAFE_INTEGER;
    }
  }
  return out.map(({ _endGiven, ...s }) => s);
}

/** The innermost function whose range contains `line` in `file` (or null). */
export function enclosingFunction(symbols: CtagsSymbol[], file: string, line: number): string | null {
  let best: CtagsSymbol | null = null;
  for (const s of symbols) {
    if (s.file !== file || s.start > line || s.end < line) continue;
    if (!best || s.start > best.start) best = s; // deepest/nearest definition
  }
  return best?.name ?? null;
}

/** Map file → changed line numbers from `git diff -U0` (new-side lines). */
export function parseDiffChangedLines(diff: string): Map<string, number[]> {
  const byFile = new Map<string, number[]>();
  let file: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const m = line.match(/^\+\+\+ b\/(.+)$/);
      file = m ? m[1] : null;
    } else if (file && line.startsWith("@@")) {
      const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (!m) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (count === 0) continue; // pure deletion — no new lines
      const arr = byFile.get(file) ?? [];
      for (let i = 0; i < count; i++) arr.push(start + i);
      byFile.set(file, arr);
    }
  }
  return byFile;
}

export function buildFreezeSet(edited: string[], callers: string[]): string[] {
  return [...new Set([...edited, ...callers])].sort();
}

/**
 * Does `candidate` look like a fork of `base` — the lease-evasion signature
 * (block `apply` → agent writes `apply_v2`)? True when candidate = base + a
 * fork-y suffix (_v2, 2, New, _copy, _impl, _tmp, …). Conservative on purpose:
 * an unrelated longer name (getData vs get) is NOT flagged.
 */
export function isNameVariant(candidate: string, base: string): boolean {
  if (candidate === base || candidate.length <= base.length) return false;
  if (candidate.slice(0, base.length).toLowerCase() !== base.toLowerCase()) return false;
  const suffix = candidate.slice(base.length);
  return /^_?(v?\d+|new|copy|impl|tmp|alt|fixed|updated|old|orig|ng|next|clone)$/i.test(suffix);
}

/** A grep hit line looks like an actual call of `name` (name immediately followed
 *  by `(`), not just a mention. Cheap filter — comments/strings slip through
 *  (over-freeze, which is safe). */
export function looksLikeCall(lineText: string, name: string): boolean {
  return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`).test(lineText);
}

// ── Shell-outs ─────────────────────────────────────────────

async function gitDiff(repoPath: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, "diff", "-U0", "--no-color"], {
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

async function runCtagsOnFiles(repoPath: string, files: string[]): Promise<CtagsSymbol[]> {
  if (!files.length) return [];
  const { stdout } = await execFileAsync(
    "ctags",
    // No --languages restriction: ctags auto-detects by extension, so Elixir/
    // Python/etc. are parsed, not just C/C++.
    ["-f", "-", "--output-format=json", "--fields=+ne", ...files],
    { cwd: repoPath, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }
  );
  // ctags paths are relative to cwd (repoPath) — matches diff/grep paths
  return parseCtags(stdout);
}

interface GrepHit {
  file: string;
  line: number;
  text: string;
}

async function grepSymbol(repoPath: string, name: string): Promise<GrepHit[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "grep", "-n", "-w", "--no-color", "-e", name, "--", ...SOURCE_GLOBS],
      { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }
    );
    const hits: GrepHit[] = [];
    for (const l of stdout.split("\n")) {
      const m = l.match(/^([^:]+):(\d+):(.*)$/);
      if (m) hits.push({ file: m[1], line: Number(m[2]), text: m[3] });
    }
    return hits;
  } catch {
    return []; // git grep exits 1 on no matches
  }
}

// ── Orchestration ──────────────────────────────────────────

export interface FreezeSet {
  edited: string[]; // functions the agent changed
  frozen: string[]; // edited ∪ callers — the leases to hold
  overflowed: string[]; // names too hot to expand (capped) — noted, not frozen wide
}

/**
 * Compute the freeze set from the current uncommitted diff in `repoPath`.
 * Best-effort: any tool failure yields a partial/empty set rather than throwing.
 */
export async function computeFreezeSet(repoPath: string): Promise<FreezeSet> {
  const diff = await gitDiff(repoPath).catch(() => "");
  const changed = parseDiffChangedLines(diff);
  const changedFiles = [...changed.keys()].filter((f) => SOURCE_GLOBS.some((g) => f.endsWith(g.slice(1))));
  if (!changedFiles.length) return { edited: [], frozen: [], overflowed: [] };

  const changedDefs = await runCtagsOnFiles(repoPath, changedFiles).catch(() => []);

  const edited = new Set<string>();
  for (const [file, lines] of changed) {
    for (const ln of lines) {
      const fn = enclosingFunction(changedDefs, file, ln);
      if (fn) edited.add(fn);
    }
  }

  const callers = new Set<string>();
  const overflowed: string[] = [];
  const defCache = new Map<string, CtagsSymbol[]>(); // file → defs
  for (const name of edited) {
    const hits = (await grepSymbol(repoPath, name)).filter((h) => looksLikeCall(h.text, name));
    if (hits.length > MAX_GREP_HITS) {
      overflowed.push(name); // too common to expand safely — freeze only the edited fn
      continue;
    }
    const hitFiles = [...new Set(hits.map((h) => h.file))];
    for (const f of hitFiles) {
      if (!defCache.has(f)) defCache.set(f, await runCtagsOnFiles(repoPath, [f]).catch(() => []));
    }
    for (const h of hits) {
      const caller = enclosingFunction(defCache.get(h.file) ?? [], h.file, h.line);
      if (caller && !edited.has(caller)) callers.add(caller);
    }
  }

  return { edited: [...edited].sort(), frozen: buildFreezeSet([...edited], [...callers]), overflowed };
}

/**
 * The enclosing function(s) of pending edits — used by the edit-time lease hook.
 * `file` may be absolute (Claude passes absolute paths) or repo-relative; each
 * `snippet` is the edit's old_string, located in the current file to find its line.
 */
export async function functionsAtEdits(repoPath: string, file: string, snippets: string[]): Promise<string[]> {
  const rel = file.startsWith(repoPath + "/") ? file.slice(repoPath.length + 1) : file;
  let content: string;
  try {
    content = await readFile(`${repoPath}/${rel}`, "utf8");
  } catch {
    return [];
  }
  const defs = await runCtagsOnFiles(repoPath, [rel]).catch(() => []);
  const fns = new Set<string>();
  for (const snip of snippets) {
    if (!snip) continue;
    const idx = content.indexOf(snip);
    if (idx < 0) continue;
    const line = content.slice(0, idx).split("\n").length; // 1-based start line of the edit
    const fn = enclosingFunction(defs, rel, line);
    if (fn) fns.add(fn);
  }
  return [...fns];
}

/** Every function ctags finds in a file — for a whole-file `Write` (which has no
 *  edit snippet to localize). The agent is rewriting the file, so every function
 *  in it is in the blast radius. Runs on the on-disk (pre-write) content, so it
 *  claims the functions being modified/removed; a brand-new file yields none. */
export async function functionsInFile(repoPath: string, file: string): Promise<string[]> {
  const rel = file.startsWith(repoPath + "/") ? file.slice(repoPath.length + 1) : file;
  const defs = await runCtagsOnFiles(repoPath, [rel]).catch(() => []);
  return [...new Set(defs.filter((d) => d.file === rel).map((d) => d.name))];
}
