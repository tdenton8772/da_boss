import { describe, it, expect } from "vitest";
import { scenarios } from "../src/testing/scenarios.js";

const steer = scenarios["mid-turn-steer"];

describe("mid-turn-steer scenario verify", () => {
  it("is pending until the steer is delivered", () => {
    const r = steer.verify(["STEP 1", "STEP 2", "STEP 3"]);
    expect(r.verdict).toBe("pending");
  });

  it("passes when interrupted mid-way, acknowledged, and redirected", () => {
    const r = steer.verify([
      "STEP 1", "STEP 2", "STEP 3", "STEP 4",
      "↪️ Steered mid-run — new instruction: STOP counting now",
      "INTERRUPTED AT 4",
      "DONE COUNTING",
    ]);
    expect(r.verdict).toBe("pass");
    expect(r.checks.every((c) => c.pass)).toBe(true);
  });

  it("fails when steered but the agent ignored the redirect", () => {
    const r = steer.verify([
      "STEP 1", "STEP 2",
      "↪️ Steered mid-run — new instruction: STOP",
      "STEP 3", "STEP 4", // kept counting
    ]);
    expect(r.verdict).toBe("fail");
  });

  it("fails when it wasn't actually interrupted (ran all 12)", () => {
    const contents = Array.from({ length: 12 }, (_, i) => `STEP ${i + 1}`);
    contents.push("↪️ Steered mid-run", "DONE COUNTING");
    const r = steer.verify(contents);
    expect(r.verdict).toBe("fail"); // steps == 12 → not interrupted mid-way
  });
});
