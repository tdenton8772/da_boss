import { describe, it, expect } from "vitest";
import { parsePipeline, isTestPhase } from "../src/pipeline/config.js";

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
});
