import type { AgentState } from "../types/agent.js";

const VALID_TRANSITIONS: Record<AgentState, AgentState[]> = {
  pending: ["running"],
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
  completed: ["verified", "running", "waiting_input"],
  verified: [],
  failed: ["running", "waiting_input", "aborted"],
  paused: ["running", "waiting_input", "aborted"],
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
