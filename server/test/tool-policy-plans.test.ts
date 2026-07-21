import { describe, it, expect } from "vitest";
import { isPathSafe, shouldAutoApprove } from "../src/agent/tool-policy.js";

describe("tool-policy — plan file writes", () => {
  it("auto-approves writing the agent's plan doc under ~/.claude/plans (outside cwd)", () => {
    // The plan write must NOT escalate to a human — escalating would stall the very plan
    // the human is waiting to approve.
    expect(isPathSafe("/root/.claude/plans/plan.md", "/work")).toBe(true);
    expect(isPathSafe("/home/agent/.claude/plans/luminous-coalescing.md", "/work")).toBe(true);
    expect(
      shouldAutoApprove("Write", { file_path: "/root/.claude/plans/plan.md" }, "/work", "auto")
    ).toBe(true);
  });

  it("still escalates writes to other out-of-sandbox paths", () => {
    expect(isPathSafe("/root/.ssh/authorized_keys", "/work")).toBe(false);
    expect(isPathSafe("/etc/passwd", "/work")).toBe(false);
    expect(
      shouldAutoApprove("Write", { file_path: "/root/.bashrc" }, "/work", "auto")
    ).toBe(false);
  });
});
