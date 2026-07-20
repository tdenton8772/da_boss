// One coherent status for an agent, derived the same way in every view (card,
// detail, anywhere). The bug this fixes: the card showed the lifecycle dimension
// ("completed"), the detail showed the test dimension ("testing"), and Reviews the
// review dimension — three vocabularies for one agent. Here they collapse into one:
// a completed agent that's still testing reads "Testing" everywhere, and it only
// reads "Ready: merge" once its review actually says so.
export interface StatusView {
  key: string;
  label: string;
  color: string;
  spin?: boolean;
}

export function deriveStatus(agent: {
  state: string;
  // Server-computed canonical status. When present it IS the answer — the UI does not
  // re-derive. The local computation below is a fallback for payloads without it.
  status?: StatusView | null;
  testing?: boolean;
  landing?: boolean;
  recommendation?: string | null;
  pr_number?: number | null;
  deployed_by_agent_id?: string | null;
  // The state of the DEPLOY AGENT that claimed this change (via deployed_by_agent_id),
  // if any — running = deploying, completed = deployed, failed = deploy failed. This
  // is what a change reads once a deploy has claimed it, so N changes in one deploy
  // move together and a prior deploy's change keeps its own status.
  deploy_agent_state?: string | null;
  // Status of an in-flight deploy for this change's repo/ref BEFORE it's claimed
  // (the gate): pending_review = tests on main, pending_approval = awaiting a human.
  deploy_status?: string | null;
}): StatusView {
  // Server is the single source of truth — render exactly what it computed.
  if (agent.status) return agent.status;
  if (agent.state === "completed" && agent.landing) return { key: "landing", label: "Landing…", color: "text-blue-400", spin: true };
  switch (agent.state) {
    case "pending": return { key: "pending", label: "Pending", color: "text-gray-400" };
    case "queued": return { key: "queued", label: "Queued — sizing", color: "text-sky-400", spin: true };
    case "running": return { key: "running", label: "Running", color: "text-green-400", spin: true };
    case "waiting_permission": return { key: "waiting_permission", label: "Needs Approval", color: "text-amber-400" };
    case "waiting_input": return { key: "waiting_input", label: "Needs Input", color: "text-amber-400" };
    case "paused": return { key: "paused", label: "Paused", color: "text-gray-400" };
    case "failed": return { key: "failed", label: "Failed", color: "text-red-400" };
    case "aborted": return { key: "aborted", label: "Aborted", color: "text-red-400" };
    // A landed change is live, being deployed right now, or merged and waiting for a
    // deploy to be kicked off — these must not all read the same "Merged". Check the
    // IN-FLIGHT deploy FIRST: `deployed_by_agent_id` is set when the deploy agent is
    // dispatched (not when it finishes), so a still-running deploy would otherwise
    // read "Deployed" prematurely while the deploy agent is only mid-run.
    case "verified": {
      // Claimed by a deploy → mirror THAT deploy agent's state (N changes in one
      // deploy read the same thing; a prior deploy's change keeps its own).
      if (agent.deployed_by_agent_id) {
        switch (agent.deploy_agent_state) {
          case "completed":
          case "verified": return { key: "deployed", label: "Deployed", color: "text-green-400" };
          case "failed":
          case "aborted": return { key: "deploy_failed", label: "Deploy failed", color: "text-red-400" };
          default: return { key: "deploying", label: "Deploying…", color: "text-blue-400", spin: true }; // pending/queued/running
        }
      }
      // Not yet claimed by a deploy → is one being gated for this repo/ref?
      switch (agent.deploy_status) {
        case "pending_review": return { key: "deploy_gate", label: "Deploy gate: testing main", color: "text-blue-400", spin: true };
        case "pending_approval": return { key: "deploy_approval", label: "Deploy: awaiting approval", color: "text-amber-400" };
        case "pending":
        case "running": return { key: "deploying", label: "Deploying…", color: "text-blue-400", spin: true };
      }
      return { key: "merged", label: "Merged · needs deploy", color: "text-sky-400" };
    }
  }
  if (agent.state === "completed") {
    // Refine the "completed" lifecycle by what's actually happening in the pipeline.
    if (agent.testing) return { key: "testing", label: "Testing", color: "text-blue-400", spin: true };
    switch (agent.recommendation) {
      case "merge": return { key: "ready", label: "Ready: merge", color: "text-green-400" };
      case "fix": return { key: "fix", label: "Review: fix", color: "text-amber-400" };
      case "hold": return { key: "hold", label: "Review: hold", color: "text-amber-400" };
    }
    if (agent.pr_number) return { key: "reviewing", label: "In review", color: "text-blue-400", spin: true };
    return { key: "done", label: "Done", color: "text-blue-400" };
  }
  return { key: agent.state, label: agent.state, color: "text-gray-400" };
}
