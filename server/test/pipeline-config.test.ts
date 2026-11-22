import { describe, it, expect } from "vitest";
import { parsePipeline, isTestPhase, pipelineWarnings } from "../src/pipeline/config.js";

describe("isTestPhase", () => {
  it("matches 'test' and 'test-<suite>' but not others", () => {
    expect(isTestPhase("test")).toBe(true);
    expect(isTestPhase("test-elixir")).toBe(true);
    expect(isTestPhase("test-web")).toBe(true);
    expect(isTestPhase("deploy")).toBe(false);
    expect(isTestPhase("preview")).toBe(false);
    expect(isTestPhase("integration")).toBe(false); // must be prefixed test-
  });
});

describe("parsePipeline", () => {
  it("parses phases with commands, requires, params, gate, lease", () => {
    const p = parsePipeline(`
version: 1
phases:
  preview:
    command: "terraform plan -no-color > $DABOSS_ARTIFACT"
    requires: [gcp-sa]
    params: { TARGET_ENV: staging }
    gate: human
  apply:
    command: "terraform apply plan.bin"
    requires: [gcp-sa]
    lease: { kind: tf_state, ref: "app/staging" }
`);
    expect(Object.keys(p.phases)).toEqual(["preview", "apply"]);
    expect(p.phases.preview).toMatchObject({ requires: ["gcp-sa"], params: { TARGET_ENV: "staging" }, gate: "human" });
    expect(p.phases.apply.lease).toEqual({ kind: "tf_state", ref: "app/staging" });
    expect(p.phases.apply.gate).toBe("auto"); // default
  });

  it("works for a dumb bash phase (no adapter, no requires)", () => {
    const p = parsePipeline(`
phases:
  deploy:
    command: "scripts/deploy-gke.sh"
`);
    expect(p.phases.deploy.command).toBe("scripts/deploy-gke.sh");
    expect(p.phases.deploy.adapter).toBeUndefined();
  });

  it("parses a phase size, and rejects one that isn't s|m|l|xl", () => {
    expect(parsePipeline("phases:\n  t:\n    command: x\n    size: xl\n").phases.t.size).toBe("xl");
    expect(parsePipeline("phases:\n  t:\n    command: x\n").phases.t.size).toBeUndefined();
    expect(() => parsePipeline("phases:\n  t:\n    command: x\n    size: huge\n")).toThrow(/size must be one of/);
  });

  it("parses agent-managed and service_account on a deploy phase", () => {
    const p = parsePipeline(`
phases:
  deploy:
    command: "bash scripts/deploy-gke.sh"
    gate: human
    only_ref: main
    service_account: daboss-deploy
    agent: true
`);
    expect(p.phases.deploy.agent).toBe(true);
    expect(p.phases.deploy.service_account).toBe("daboss-deploy");
    expect(p.phases.deploy.gate).toBe("human");
  });

  it("defaults agent to false when unset", () => {
    const p = parsePipeline("phases:\n  test:\n    command: pytest\n");
    expect(p.phases.test.agent).toBe(false);
  });

  it("rejects a phase with no command", () => {
    expect(() => parsePipeline("phases:\n  x:\n    requires: [a]\n")).toThrow(/needs a non-empty 'command'/);
  });

  it("rejects a bad gate and a malformed lease", () => {
    expect(() => parsePipeline("phases:\n  x:\n    command: run\n    gate: maybe\n")).toThrow(/gate must be/);
    expect(() => parsePipeline("phases:\n  x:\n    command: run\n    lease: { kind: k }\n")).toThrow(/lease needs/);
  });

  it("rejects empty / non-map input", () => {
    expect(() => parsePipeline("phases: []\n")).toThrow(/phases must be a map/);
    expect(() => parsePipeline("phases: {}\n")).toThrow(/no phases/);
  });

  it("parses agents.auto_approve_tools (repo-declared permission trust)", () => {
    const p = parsePipeline(
      "phases:\n  test:\n    command: pytest\nagents:\n  auto_approve_tools:\n    - mcp__app-memory__search_knowledge_base\n    - mcp__schema-oracle__lookup\n"
    );
    expect(p.agents?.auto_approve_tools).toEqual([
      "mcp__app-memory__search_knowledge_base",
      "mcp__schema-oracle__lookup",
    ]);
    // absent section stays undefined; malformed shapes are rejected loudly
    expect(parsePipeline("phases:\n  test:\n    command: pytest\n").agents).toBeUndefined();
    expect(() => parsePipeline("phases:\n  t:\n    command: x\nagents: [a]\n")).toThrow(/agents must be a mapping/);
    expect(() => parsePipeline("phases:\n  t:\n    command: x\nagents:\n  auto_approve_tools: nope\n")).toThrow(/must be a list of strings/);
  });
});

describe("agent default (fail closed for deploy)", () => {
  it("defaults agent to true for 'deploy' and false for other phases", () => {
    const p = parsePipeline(`
phases:
  test: { command: "true" }
  deploy: { command: "./deploy.sh", gate: human }
  beta: { command: "./beta.sh", gate: human }
`);
    expect(p.phases.deploy.agent).toBe(true);
    expect(p.phases.deploy.agent_explicit).toBe(false);
    expect(p.phases.test.agent).toBe(false);
    expect(p.phases.beta.agent).toBe(false);
  });
  it("honours an explicit agent: false on deploy, and agent: true elsewhere", () => {
    const p = parsePipeline(`
phases:
  deploy: { command: "./deploy.sh", gate: human, agent: false }
  apply: { command: "./apply.sh", gate: human, agent: true }
`);
    expect(p.phases.deploy.agent).toBe(false);
    expect(p.phases.deploy.agent_explicit).toBe(true);
    expect(p.phases.apply.agent).toBe(true);
    expect(p.phases.apply.agent_explicit).toBe(true);
  });
  it("rejects a non-boolean agent", () => {
    expect(() => parsePipeline(`
phases:
  deploy: { command: "x", agent: "yes" }
`)).toThrow(/agent must be true or false/);
  });
  it("warns about an untracked deploy, an ungated agent, and an ignored image", () => {
    const w = pipelineWarnings(parsePipeline(`
phases:
  deploy: { command: "x", gate: human, agent: false }
  apply: { command: "y", agent: true, image: "alpine" }
`));
    expect(w.some((s) => s.includes("'deploy' has agent: false") && s.includes("NOT be marked Deployed"))).toBe(true);
    expect(w.some((s) => s.includes("'apply'") && s.includes("gate: human"))).toBe(true);
    expect(w.some((s) => s.includes("'apply'") && s.includes("image (alpine) is ignored"))).toBe(true);
    expect(pipelineWarnings(parsePipeline(`
phases:
  deploy: { command: "x", gate: human }
`))).toEqual([]);
  });
});
