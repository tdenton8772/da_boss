import { describe, it, expect } from "vitest";
import type * as k8s from "@kubernetes/client-node";
import * as queries from "../src/db/queries.js";
import { failUnrecordedPipelineRun, redactUrlCredentials } from "../src/agent/pod-dispatcher.js";

// A pipeline pod can die before its runner/recorder writes a verdict: the clone init
// container fails (DNS, auth), the toolchain image won't start, the recorder is
// OOM-killed. Nothing else finishes that run: it read "pending" until the orphan sweep
// aborted it 15 minutes later as "launch died before pod creation", which hid the cause.

const failedClonePod = (runId: string): k8s.V1Pod => ({
  metadata: { name: `daboss-pl-${runId.toLowerCase()}`, annotations: { "daboss.run-id": runId } },
  status: {
    phase: "Failed",
    initContainerStatuses: [
      { name: "clone", state: { terminated: { exitCode: 128, reason: "Error" } } } as k8s.V1ContainerStatus,
    ],
    containerStatuses: [
      { name: "task", state: { waiting: { reason: "PodInitializing" } } } as k8s.V1ContainerStatus,
      { name: "recorder", state: { waiting: { reason: "PodInitializing" } } } as k8s.V1ContainerStatus,
    ],
  },
} as k8s.V1Pod);

async function seed(id: string, status: string): Promise<void> {
  await queries.insertPipelineRun({ id, repoUrl: "https://github.com/x/y", ref: "main", phase: "test", status });
}

describe("failUnrecordedPipelineRun", () => {
  it("fails a pending run with the failing container, its exit code and log tail", async () => {
    await seed("run_clone", "pending");
    const tail = "Cloning into '/work'...\nfatal: unable to access 'https://github.com/x/y/': Could not resolve host: github.com\n";
    expect(await failUnrecordedPipelineRun(failedClonePod("run_clone"), tail)).toBe(true);

    const run = await queries.getPipelineRun("run_clone");
    expect(run?.status).toBe("failed");
    expect(run?.completed_at).toBeTruthy();
    expect(run?.log).toContain("container clone (exit code 128)");
    expect(run?.log).toContain("Could not resolve host");
  });

  it("leaves a run the pod already recorded alone", async () => {
    for (const status of ["passed", "failed", "aborted"]) {
      await seed(`run_${status}`, status);
      expect(await failUnrecordedPipelineRun(failedClonePod(`run_${status}`))).toBe(false);
      expect((await queries.getPipelineRun(`run_${status}`))?.status).toBe(status);
    }
  });

  it("ignores pods without a run id and unknown runs", async () => {
    expect(await failUnrecordedPipelineRun({ metadata: { name: "x" }, status: { phase: "Failed" } } as k8s.V1Pod)).toBe(false);
    expect(await failUnrecordedPipelineRun(failedClonePod("run_missing"))).toBe(false);
  });

  it("never writes a credential from an authed URL into the run log", async () => {
    await seed("run_authed", "running");
    await failUnrecordedPipelineRun(failedClonePod("run_authed"), "fatal: repository 'https://x-access-token:ghp_secret@github.com/x/y/' not found");
    const log = (await queries.getPipelineRun("run_authed"))?.log ?? "";
    expect(log).not.toContain("ghp_secret");
    expect(log).toContain("https://***@github.com/x/y/");
  });
});

describe("redactUrlCredentials", () => {
  it("masks userinfo in any URL and leaves plain URLs alone", () => {
    expect(redactUrlCredentials("a https://u:p@h/x b git://tok@h c")).toBe("a https://***@h/x b git://***@h c");
    expect(redactUrlCredentials("https://github.com/x/y and me@example.com")).toBe("https://github.com/x/y and me@example.com");
  });
});
