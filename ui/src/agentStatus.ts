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
  testing?: boolean;
  recommendation?: string | null;
  pr_number?: number | null;
  deployed_by_agent_id?: string | null;
}): StatusView {
  switch (agent.state) {
    case "pending": return { key: "pending", label: "Pending", color: "text-gray-400" };
    case "running": return { key: "running", label: "Running", color: "text-green-400", spin: true };
    case "waiting_permission": return { key: "waiting_permission", label: "Needs Approval", color: "text-amber-400" };
    case "waiting_input": return { key: "waiting_input", label: "Needs Input", color: "text-amber-400" };
    case "paused": return { key: "paused", label: "Paused", color: "text-gray-400" };
    case "failed": return { key: "failed", label: "Failed", color: "text-red-400" };
    case "aborted": return { key: "aborted", label: "Aborted", color: "text-red-400" };
    // A landed change is either live (a later deploy shipped it) or merged and
    // waiting for the next deploy — never let both read the same "Merged".
    case "verified": return agent.deployed_by_agent_id
      ? { key: "deployed", label: "Deployed", color: "text-green-400" }
      : { key: "merged", label: "Merged · needs deploy", color: "text-sky-400" };
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
