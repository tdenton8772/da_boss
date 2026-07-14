import { describe, it, expect } from "vitest";
import { resolvePreset, nextSizeUp, normalizeSize, DEFAULT_SIZE, SIZES } from "../src/agent/sizing.js";

describe("t-shirt pod sizing", () => {
  it("normalizes case + rejects unknown", () => {
    expect(normalizeSize("L")).toBe("l");
    expect(normalizeSize(" xl ")).toBe("xl");
    expect(normalizeSize("huge")).toBeNull();
    expect(normalizeSize(null)).toBeNull();
    expect(normalizeSize(undefined)).toBeNull();
  });

  it("resolves presets; unknown/absent → default M", () => {
    expect(resolvePreset("s").limits.memory).toBe("512Mi");
    expect(resolvePreset("xl").limits.memory).toBe("8Gi");
    expect(resolvePreset(null)).toEqual(resolvePreset(DEFAULT_SIZE));
    expect(resolvePreset("bogus")).toEqual(resolvePreset("m"));
  });

  it("every preset caps ephemeral storage + memory (avoids the crash mode)", () => {
    for (const s of SIZES) {
      const p = resolvePreset(s);
      expect(p.limits["ephemeral-storage"]).toBeTruthy();
      expect(p.limits.memory).toBeTruthy();
      expect(p.requests.cpu).toBeTruthy();
    }
  });

  it("bumps one size up on resource failure, capping at XL", () => {
    expect(nextSizeUp("s")).toBe("m");
    expect(nextSizeUp("m")).toBe("l");
    expect(nextSizeUp("l")).toBe("xl");
    expect(nextSizeUp("xl")).toBe("xl"); // caps
    expect(nextSizeUp(null)).toBe("l"); // default M → L
  });
});
