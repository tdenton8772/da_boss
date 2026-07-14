import { describe, it, expect } from "vitest";
import { assessSize } from "../src/supervisor/dispatcher.js";
import type { AgentRecord } from "../src/types/agent.js";

// assessSize only reads size / error_message / prompt / id.
const agent = (over: Partial<AgentRecord>): AgentRecord => ({ id: "a", ...over }) as AgentRecord;

describe("supervisor sizing — resource-failure bump (deterministic, no Claude)", () => {
  it("bumps one size up when the prior run died on resources", async () => {
    expect(await assessSize(agent({ size: "m", error_message: "Pod OOMKilled (exit code 137)" }))).toBe("l");
    expect(await assessSize(agent({ size: "l", error_message: "Evicted: no space left on device" }))).toBe("xl");
  });

  it("caps the bump at XL", async () => {
    expect(await assessSize(agent({ size: "xl", error_message: "OOMKilled" }))).toBe("xl");
  });

  it("does NOT bump when the failure was unrelated to resources (e.g. a 403)", async () => {
    // no resource signal → falls through to the Claude/default path, not a bump.
    // With no supervisor credential in the test env it defaults to 'm' (not 'l').
    const s = await assessSize(agent({ size: "m", error_message: "Request failed with status code 403" }));
    expect(s).not.toBe("l");
  });
});
