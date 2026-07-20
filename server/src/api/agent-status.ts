/**
 * THE canonical agent status — computed once, on the server, and attached to every
 * agent payload (`agent.status`) by both the list and detail endpoints. The UI never
 * re-derives it; it just renders `agent.status`. This is the single source of truth
 * so the dashboard card, the detail header, and Reviews can NEVER disagree.
 *
 * It collapses three dimensions (lifecycle state + pipeline activity + deploy) into
 * one label. Keep the key set in sync with the UI's icon/spin map (STATUS_ICON).
 */
export interface StatusView {
  key: string;
  label: string;
  color: string;
  spin?: boolean;
}

/** Everything the status depends on — the caller (list or detail endpoint) MUST
 *  populate these identically so the computed status matches everywhere. */
export interface StatusInputs {
  state: string;
  testing?: boolean | null; // a test phase is running on this agent's branch
  landing?: boolean | null; // a Merge is landing (rebase-on-main + retest) right now
  recommendation?: string | null;
  pr_number?: number | null;
  deployed_by_agent_id?: string | null;
  deploy_agent_state?: string | null; // state of the deploy agent that claimed this change
  deploy_status?: string | null; // in-flight deploy gate for this repo/ref, pre-claim
}

export function computeAgentStatus(a: StatusInputs): StatusView {
  switch (a.state) {
    case "pending": return { key: "pending", label: "Pending", color: "text-gray-400" };
    case "queued": return { key: "queued", label: "Queued — sizing", color: "text-sky-400", spin: true };
    case "running": return { key: "running", label: "Running", color: "text-green-400", spin: true };
    case "waiting_permission": return { key: "waiting_permission", label: "Needs Approval", color: "text-amber-400" };
    case "waiting_input": return { key: "waiting_input", label: "Needs Input", color: "text-amber-400" };
    case "paused": return { key: "paused", label: "Paused", color: "text-gray-400" };
    case "failed": return { key: "failed", label: "Failed", color: "text-red-400" };
    case "aborted": return { key: "aborted", label: "Aborted", color: "text-red-400" };
    case "verified": {
      // Claimed by a deploy → mirror THAT deploy agent's state (dispatch sets
      // deployed_by_agent_id, so check its state — not merely its presence).
      if (a.deployed_by_agent_id) {
        switch (a.deploy_agent_state) {
          case "completed":
          case "verified": return { key: "deployed", label: "Deployed", color: "text-green-400" };
          case "failed":
          case "aborted": return { key: "deploy_failed", label: "Deploy failed", color: "text-red-400" };
          default: return { key: "deploying", label: "Deploying…", color: "text-blue-400", spin: true };
        }
      }
      switch (a.deploy_status) {
        case "pending_review": return { key: "deploy_gate", label: "Deploy gate: testing main", color: "text-blue-400", spin: true };
        case "pending_approval": return { key: "deploy_approval", label: "Deploy: awaiting approval", color: "text-amber-400" };
        case "pending":
        case "running": return { key: "deploying", label: "Deploying…", color: "text-blue-400", spin: true };
      }
      return { key: "merged", label: "Merged · needs deploy", color: "text-sky-400" };
    }
  }
  if (a.state === "completed") {
    if (a.landing) return { key: "landing", label: "Landing…", color: "text-blue-400", spin: true };
    if (a.testing) return { key: "testing", label: "Testing", color: "text-blue-400", spin: true };
    switch (a.recommendation) {
      case "merge": return { key: "ready", label: "Ready: merge", color: "text-green-400" };
      case "fix": return { key: "fix", label: "Review: fix", color: "text-amber-400" };
      case "hold": return { key: "hold", label: "Review: hold", color: "text-amber-400" };
    }
    if (a.pr_number) return { key: "reviewing", label: "In review", color: "text-blue-400", spin: true };
    return { key: "done", label: "Done", color: "text-blue-400" };
  }
  return { key: a.state, label: a.state, color: "text-gray-400" };
}
