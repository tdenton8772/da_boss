import { describe, it, expect } from "vitest";
import { computeAgentStatus } from "../src/api/agent-status.js";

// The canonical status the server computes once and both the list + detail endpoints
// attach — so the card, detail header, and Reviews can never disagree. Lock the
// dimension-collapsing rules here.
describe("computeAgentStatus", () => {
  it("maps lifecycle states directly", () => {
    expect(computeAgentStatus({ state: "running" }).key).toBe("running");
    expect(computeAgentStatus({ state: "queued" }).key).toBe("queued");
    expect(computeAgentStatus({ state: "paused" }).key).toBe("paused");
    expect(computeAgentStatus({ state: "failed" }).key).toBe("failed");
  });

  it("completed refines by pipeline activity, in priority order", () => {
    // landing (Merge in flight) beats everything else on a completed agent
    expect(computeAgentStatus({ state: "completed", landing: true, testing: true, recommendation: "merge" }).key).toBe("landing");
    // then a running test
    expect(computeAgentStatus({ state: "completed", testing: true, recommendation: "merge" }).key).toBe("testing");
    // then the review recommendation
    expect(computeAgentStatus({ state: "completed", recommendation: "merge" }).key).toBe("ready");
    expect(computeAgentStatus({ state: "completed", recommendation: "fix" }).key).toBe("fix");
    expect(computeAgentStatus({ state: "completed", recommendation: "hold" }).key).toBe("hold");
    // nothing else = done
    expect(computeAgentStatus({ state: "completed" }).key).toBe("done");
  });

  it("splits needs-review from in-review", () => {
    // A review agent actively working = In review (spins)
    const inReview = computeAgentStatus({ state: "completed", reviewing: true, pr_number: 7 });
    expect(inReview.key).toBe("reviewing");
    expect(inReview.spin).toBe(true);
    // An open PR with no live reviewer and no verdict = Needs review (does NOT spin —
    // nothing is happening; the old conflated status lied with a spinner here)
    const needs = computeAgentStatus({ state: "completed", pr_number: 7 });
    expect(needs.key).toBe("needs_review");
    expect(needs.spin).toBeUndefined();
    // An ACTIVE re-review beats the stale verdict from the previous round
    expect(computeAgentStatus({ state: "completed", reviewing: true, recommendation: "fix", pr_number: 7 }).key).toBe("reviewing");
    // but testing/landing still outrank an active review
    expect(computeAgentStatus({ state: "completed", testing: true, reviewing: true }).key).toBe("testing");
    expect(computeAgentStatus({ state: "completed", landing: true, reviewing: true }).key).toBe("landing");
  });

  it("verified follows the claiming deploy agent's state first", () => {
    expect(computeAgentStatus({ state: "verified", deployed_by_agent_id: "ag_d", deploy_agent_state: "completed" }).key).toBe("deployed");
    expect(computeAgentStatus({ state: "verified", deployed_by_agent_id: "ag_d", deploy_agent_state: "running" }).key).toBe("deploying");
    expect(computeAgentStatus({ state: "verified", deployed_by_agent_id: "ag_d", deploy_agent_state: "failed" }).key).toBe("deploy_failed");
  });

  it("verified with an unclaimed in-flight deploy reflects the gate", () => {
    expect(computeAgentStatus({ state: "verified", deploy_status: "pending_review" }).key).toBe("deploy_gate");
    expect(computeAgentStatus({ state: "verified", deploy_status: "pending_approval" }).key).toBe("deploy_approval");
    expect(computeAgentStatus({ state: "verified", deploy_status: "running" }).key).toBe("deploying");
    // merged but no deploy anywhere
    expect(computeAgentStatus({ state: "verified" }).key).toBe("merged");
  });
});
