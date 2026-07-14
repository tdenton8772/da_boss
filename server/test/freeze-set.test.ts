import { describe, it, expect } from "vitest";
import {
  parseCtags,
  enclosingFunction,
  parseDiffChangedLines,
  looksLikeCall,
  buildFreezeSet,
  isNameVariant,
} from "../src/leasing/freeze-set.js";

describe("freeze-set (pure)", () => {
  const CTAGS = [
    '{"_type":"tag","name":"apply","path":"raft/server.cc","kind":"function","line":42,"end":58}',
    '{"_type":"tag","name":"helper","path":"raft/server.cc","kind":"method","line":60,"end":70}',
    '{"_type":"tag","name":"Server","path":"raft/server.hh","kind":"class","line":10,"end":90}',
    "not json",
  ].join("\n");

  it("parseCtags keeps functions/methods, drops classes and junk", () => {
    const syms = parseCtags(CTAGS);
    expect(syms.map((s) => s.name).sort()).toEqual(["apply", "helper"]);
    expect(syms.find((s) => s.name === "apply")).toMatchObject({ start: 42, end: 58, file: "raft/server.cc" });
  });

  it("enclosingFunction finds the innermost range (or null)", () => {
    const syms = parseCtags(CTAGS);
    expect(enclosingFunction(syms, "raft/server.cc", 50)).toBe("apply");
    expect(enclosingFunction(syms, "raft/server.cc", 65)).toBe("helper");
    expect(enclosingFunction(syms, "raft/server.cc", 100)).toBeNull();
    expect(enclosingFunction(syms, "other.cc", 50)).toBeNull();
  });

  it("synthesizes end-lines when ctags omits them (e.g. Elixir def) → multi-line ranges", () => {
    // Elixir: ctags gives `def`s NO end field (only the module gets one). Without
    // synthesis every function was a single line and enclosingFunction never matched.
    const ELIXIR = [
      '{"_type":"tag","name":"record","path":"lib/activity.ex","kind":"function","line":10}',
      '{"_type":"tag","name":"flush","path":"lib/activity.ex","kind":"function","line":25}',
      "",
    ].join("\n");
    const syms = parseCtags(ELIXIR);
    // record runs [10, 24] (up to just before flush); flush runs to EOF.
    expect(syms.find((s) => s.name === "record")).toMatchObject({ start: 10, end: 24 });
    expect(syms.find((s) => s.name === "flush")!.end).toBeGreaterThan(25);
    // an edit on line 15 now maps to `record` (previously mapped to nothing)
    expect(enclosingFunction(syms, "lib/activity.ex", 15)).toBe("record");
    expect(enclosingFunction(syms, "lib/activity.ex", 40)).toBe("flush");
  });

  it("parseDiffChangedLines extracts new-side line numbers per file", () => {
    const diff = [
      "diff --git a/raft/server.cc b/raft/server.cc",
      "--- a/raft/server.cc",
      "+++ b/raft/server.cc",
      "@@ -42,3 +42,2 @@ void apply()",
      "@@ -60,0 +63,2 @@ int helper()",
      "diff --git a/x/y.cc b/x/y.cc",
      "--- a/x/y.cc",
      "+++ b/x/y.cc",
      "@@ -5 +5 @@",
    ].join("\n");
    const m = parseDiffChangedLines(diff);
    expect(m.get("raft/server.cc")).toEqual([42, 43, 63, 64]);
    expect(m.get("x/y.cc")).toEqual([5]); // no count → 1 line
  });

  it("parseDiffChangedLines ignores pure deletions (+n,0)", () => {
    const diff = ["+++ b/a.cc", "@@ -10,2 +9,0 @@"].join("\n");
    expect(parseDiffChangedLines(diff).get("a.cc")).toBeUndefined();
  });

  it("looksLikeCall matches calls, not mentions or substrings", () => {
    expect(looksLikeCall("  x = apply(foo);", "apply")).toBe(true);
    expect(looksLikeCall("  apply (foo);", "apply")).toBe(true);
    expect(looksLikeCall("// TODO: apply the thing", "apply")).toBe(false);
    expect(looksLikeCall("  myapply(x);", "apply")).toBe(false); // word boundary
  });

  it("buildFreezeSet unions and dedupes edited + callers", () => {
    expect(buildFreezeSet(["apply", "helper"], ["caller1", "apply"])).toEqual(["apply", "caller1", "helper"]);
  });

  it("isNameVariant flags forks of a frozen symbol, not unrelated names", () => {
    for (const v of ["apply_v2", "apply2", "applyNew", "apply_copy", "apply_impl", "applyV2", "apply_next"]) {
      expect(isNameVariant(v, "apply")).toBe(true);
    }
    for (const v of ["apply", "applied", "applyData", "reapply", "app"]) {
      expect(isNameVariant(v, "apply")).toBe(false);
    }
  });
});
