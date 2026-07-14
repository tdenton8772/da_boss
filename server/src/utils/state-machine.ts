import type { AgentState } from "../types/agent.js";

const VALID_TRANSITIONS: Record<AgentState, AgentState[]> = {
  // "queued" = created/started, awaiting the supervisor to size + build the pod.
  pending: ["queued", "running"],
  queued: ["running", "failed", "aborted"],
  running: [
    "waiting_permission",
    "waiting_input",
    "completed",
    "failed",
    "paused",
    "aborted",
  ],
  waiting_permission: ["running", "aborted"],
  waiting_input: ["running", "paused", "completed", "aborted"],
  completed: ["queued", "verified", "running", "waiting_input"],
  verified: [],
  failed: ["queued", "running", "waiting_input", "aborted"],
  paused: ["queued", "running", "waiting_input", "aborted"],
  aborted: [],
};

export function canTransition(from: AgentState, to: AgentState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: AgentState, to: AgentState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid state transition: ${from} → ${to}`);
  }
}
