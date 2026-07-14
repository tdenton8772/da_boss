import { describe, it, expect } from "vitest";
import { computeLeaseOverlap } from "../src/supervisor/checks.js";

const L = (holder: string, sym: string) => ({ resource_ref: `repo#${sym}`, holder_agent_id: holder });

describe("computeLeaseOverlap", () => {
  it("finds no contest when agents hold disjoint symbols", () => {
    const o = computeLeaseOverlap([L("a", "foo"), L("b", "bar")]);
    expect(o.contested).toBe(0);
    expect(o.deepest).toBeNull();
  });

  it("counts contested symbols and the deepest pair", () => {
    const o = computeLeaseOverlap([
      L("a", "foo"), L("b", "foo"), // contested
      L("a", "baz"), L("b", "baz"), // contested (a&b now share 2)
      L("a", "solo"),
      L("c", "qux"), L("a", "qux"), // contested (a&c share 1)
    ]);
    expect(o.contested).toBe(3);
    expect(o.deepest).toEqual({ a: "a", b: "b", symbols: ["foo", "baz"] });
  });
});
