export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  prompt: string;
  model: string;
  max_turns: number | null;
  permission_policy: "auto" | "ask" | "strict";
  supervisor_instructions: string;
  priority: "high" | "medium" | "low";
}

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: "implementer",
    name: "Implementer",
    description: "Builds features from specs or descriptions. Writes code, creates files, runs tests.",
    prompt: "Implement the following feature. Write clean, well-tested code. Run any existing tests after your changes to make sure nothing is broken.\n\nFeature: ",
    model: "claude-sonnet-4-6",
    max_turns: null,
    permission_policy: "auto",
    supervisor_instructions: "If the agent completes, verify tests pass. If tests fail, send it back with the failures. If it's stuck or confused, notify me.",
    priority: "medium",
  },
  {
    id: "code-reviewer",
    name: "Code Reviewer",
    description: "Reviews code for bugs, security issues, style, and best practices. Read-only.",
    prompt: "Review the code in this project. Look for:\n- Bugs and logic errors\n- Security vulnerabilities\n- Performance issues\n- Code style and best practices\n- Missing error handling\n- Test coverage gaps\n\nProvide a structured review with severity levels (critical/warning/info). Focus on: ",
    model: "claude-sonnet-4-6",
    max_turns: 5,
    permission_policy: "strict",
    supervisor_instructions: "When the review is done, notify me with a summary. No follow-up needed.",
    priority: "low",
  },
  {
    id: "test-writer",
    name: "Test Writer",
    description: "Writes comprehensive tests for existing code. Focuses on edge cases and coverage.",
    prompt: "Write comprehensive tests for this project. Focus on:\n- Unit tests for core functions\n- Edge cases and error conditions\n- Integration tests for key workflows\n- Run the tests to make sure they pass.\n\nTarget: ",
    model: "claude-sonnet-4-6",
    max_turns: null,
    permission_policy: "auto",
    supervisor_instructions: "If tests are written and passing, mark as done. If there are failures, send it back to fix them.",
    priority: "medium",
  },
  {
    id: "bug-fixer",
    name: "Bug Fixer",
    description: "Diagnoses and fixes bugs. Investigates root cause, applies fix, verifies with tests.",
    prompt: "Find and fix the following bug. Investigate the root cause, apply the minimal fix, and verify it with a test.\n\nBug: ",
    model: "claude-sonnet-4-6",
    max_turns: null,
    permission_policy: "auto",
    supervisor_instructions: "If the fix is applied and tests pass, mark as done. If it cannot reproduce the bug, notify me.",
    priority: "high",
  },
  {
    id: "refactorer",
    name: "Refactorer",
    description: "Refactors code for clarity, performance, or architecture changes. Preserves behavior.",
    prompt: "Refactor the following code. Preserve all existing behavior and ensure tests still pass after your changes.\n\nRefactoring target: ",
    model: "claude-sonnet-4-6",
    max_turns: null,
    permission_policy: "auto",
    supervisor_instructions: "Verify all tests pass after refactoring. If any fail, send it back. When done, notify me with a summary of changes.",
    priority: "low",
  },
  {
    id: "doc-writer",
    name: "Documentation Writer",
    description: "Writes or updates documentation, READMEs, inline comments, and API docs.",
    prompt: "Write or update documentation for this project. Include:\n- README with setup instructions\n- Inline comments for complex logic\n- API documentation for public interfaces\n\nFocus on: ",
    model: "claude-sonnet-4-6",
    max_turns: 5,
    permission_policy: "auto",
    supervisor_instructions: "When documentation is written, mark as done. Notify me with a summary.",
    priority: "low",
  },
];
