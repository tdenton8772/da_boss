import { describe, it, expect } from "vitest";
import type * as k8s from "@kubernetes/client-node";
import { podFailureReason } from "../src/agent/pod-dispatcher.js";

// The reason string must carry the literal "OOMKilled"/"exit code N" tokens the
// dispatcher's RESOURCE_FAILURE regex keys on — that's what makes an OOM-killed
// agent requeue at the next size up instead of redispatching at the size that
// just killed it (the ag_paUbu3U8 incident).

const pod = (status: Partial<k8s.V1PodStatus>): k8s.V1Pod => ({ status } as k8s.V1Pod);

describe("podFailureReason — why did a Failed pod die", () => {
  it("names an OOMKilled container with its exit code", () => {
    const p = pod({
      containerStatuses: [
        { name: "agent", state: { terminated: { exitCode: 137, reason: "OOMKilled" } } } as k8s.V1ContainerStatus,
      ],
    });
    expect(podFailureReason(p)).toBe("container agent OOMKilled (exit code 137)");
    expect(podFailureReason(p)).toMatch(/OOMKilled|exit code 137/i); // dispatcher bump trigger
  });

  it("falls back to lastState when the live state has no termination", () => {
    const p = pod({
      containerStatuses: [
        { name: "agent", state: {}, lastState: { terminated: { exitCode: 137, reason: "OOMKilled" } } } as k8s.V1ContainerStatus,
      ],
    });
    expect(podFailureReason(p)).toContain("OOMKilled");
  });

  it("skips clean exits and reports the container that actually failed", () => {
    const p = pod({
      containerStatuses: [
        { name: "agent", state: { terminated: { exitCode: 0, reason: "Completed" } } } as k8s.V1ContainerStatus,
      ],
      initContainerStatuses: [
        { name: "sidecar", state: { terminated: { exitCode: 1, reason: "Error" } } } as k8s.V1ContainerStatus,
      ],
    });
    expect(podFailureReason(p)).toBe("container sidecar (exit code 1)");
  });

  it("pod-level reason (e.g. Evicted) when no container terminated dirty", () => {
    expect(podFailureReason(pod({ reason: "Evicted" }))).toBe("Evicted");
    expect(podFailureReason(pod({}))).toBe("unknown failure");
  });
});
