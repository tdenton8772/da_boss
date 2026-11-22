import { describe, it, expect, afterEach } from "vitest";
import { config } from "../src/config.js";
import { runsAsAgent } from "../src/pipeline/deploy-agent.js";
import { parsePipeline } from "../src/pipeline/config.js";

const phases = parsePipeline(`
phases:
  deploy: { command: "x", gate: human }
  explicit: { command: "x", gate: human, agent: true }
  plain: { command: "x", gate: human, agent: false }
`).phases;

describe("runsAsAgent", () => {
  const saved = config.deployAgentImage;
  afterEach(() => { (config as { deployAgentImage: string }).deployAgentImage = saved; });

  it("dispatches an agent for a defaulted deploy when the agent image exists", () => {
    (config as { deployAgentImage: string }).deployAgentImage = "registry/deployer:1";
    expect(runsAsAgent(phases.deploy)).toBe(true);
    expect(runsAsAgent(phases.explicit)).toBe(true);
    expect(runsAsAgent(phases.plain)).toBe(false);
  });
  it("falls back to a plain pod for a DEFAULTED deploy with no agent image; explicit still asks for an agent", () => {
    (config as { deployAgentImage: string }).deployAgentImage = "";
    expect(runsAsAgent(phases.deploy)).toBe(false);
    expect(runsAsAgent(phases.explicit)).toBe(true);   // dispatch then refuses with a clear error
    expect(runsAsAgent(phases.plain)).toBe(false);
  });
});
