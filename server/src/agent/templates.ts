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
    id: "pr-adopter",
    name: "PR Adopter",
    description: "Takes over an existing PR or branch — addresses feedback, finishes the work, gets tests green. Fill in 'Adopt existing PR or branch' below.",
    prompt: "You are taking over an existing pull request — the branch is already checked out. First run `git log` and `git diff` against the base branch to understand what the original author built and how far they got. Preserve their approach and style unless something is genuinely broken; finish the work, don't rewrite it.\n\nThen: address the feedback below, complete anything half-done, and run the tests until they pass. Commit on this same branch.\n\nFeedback / what still needs doing: ",
    model: "claude-sonnet-5",
    max_turns: null,
    permission_policy: "auto",
    supervisor_instructions: "If the agent completes, verify tests pass and each feedback item was addressed. If tests fail or feedback was skipped, send it back with the specifics. If it wants to rewrite the PR from scratch, notify me first.",
    priority: "medium",
  },
  {
    id: "code-reviewer",
    name: "Code Reviewer",
    description: "Reviews code for bugs, security issues, style, and best practices. Read-only.",
    prompt: "Review the code in this project. Look for:\n- Bugs and logic errors\n- Security vulnerabilities\n- Performance issues\n- Code style and best practices\n- Missing error handling\n- Test coverage gaps\n\nProvide a structured review with severity levels (critical/warning/info). Focus on: ",
    model: "claude-sonnet-5",
    // A real review reads+greps many files before it can report; a tiny cap makes
    // the agent stop mid-investigation with no report. Read-only (strict policy),
    // so there's no write risk to bound against.
    max_turns: 50,
    permission_policy: "strict",
    supervisor_instructions: "When the review is done, notify me with a summary. No follow-up needed.",
    priority: "low",
  },
  {
    id: "test-writer",
    name: "Test Writer",
    description: "Writes comprehensive tests for existing code. Focuses on edge cases and coverage.",
    prompt: "Write comprehensive tests for this project. Focus on:\n- Unit tests for core functions\n- Edge cases and error conditions\n- Integration tests for key workflows\n- Run the tests to make sure they pass.\n\nTarget: ",
    model: "claude-sonnet-5",
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
    model: "claude-sonnet-5",
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
    model: "claude-sonnet-5",
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
    model: "claude-sonnet-5",
    max_turns: 50,
    permission_policy: "auto",
    supervisor_instructions: "When documentation is written, mark as done. Notify me with a summary.",
    priority: "low",
  },
];
