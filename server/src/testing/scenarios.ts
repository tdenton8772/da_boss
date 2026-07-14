/**
 * Live-agent test scenarios. Unlike the scripted (WORKER_SCRIPT) collision tests,
 * these run a REAL Claude agent against a NARRATIVE prompt written to drive it to
 * a known, observable state — for the paths that can't be faked (chiefly the
 * mid-turn interrupt+redirect). The narrative asks the agent to emit machine-
 * checkable markers so `verify()` can render a verdict from the event log alone.
 */
export interface ScenarioCheck {
  label: string;
  pass: boolean;
}

/** Extra signals available to verify beyond the event stream. */
export interface ScenarioContext {
  pipelineRuns: Array<{ phase: string; status: string; pr_posted: boolean }>;
  prOpened: boolean;
}

export interface Scenario {
  name: string;
  description: string;
  prompt: string;
  /** If set, the agent clones this repo and can push a branch / open a PR. */
  repo?: string;
  branchType?: string;
  /** If set, the runner sends this steer message this long after start. */
  steerAfterMs?: number;
  steerMessage?: string;
  /** If set, the runner runs the repo's `test` phase once the agent opens a PR. */
  autoTest?: boolean;
  /** Verdict from the agent's events + optional richer context. */
  verify(contents: string[], ctx?: ScenarioContext): { checks: ScenarioCheck[]; verdict: "pass" | "fail" | "pending" };
}

const MID_TURN_STEER: Scenario = {
  name: "mid-turn-steer",
  description:
    "Proves the supervisor/human can interrupt a running agent mid-turn and redirect it WITHOUT killing the work — the agent stops what it was doing and follows the new instruction, keeping context.",
  prompt: [
    "This is an automated interrupt test. Follow these instructions EXACTLY and literally.",
    "",
    "Count from 1 to 12, ONE number at a time, in order. For each number N:",
    "  1. Run this exact bash command: sleep 2",
    "  2. Then output a single line, exactly: STEP N",
    "Do them strictly one at a time — never batch, never skip the sleep.",
    "",
    "IMPORTANT: If at any point you receive a NEW instruction telling you to stop,",
    "immediately stop counting and output a single line exactly:",
    "  INTERRUPTED AT <the last N you completed>",
    "then do exactly what the new instruction says.",
    "",
    "Begin now with N = 1.",
  ].join("\n"),
  steerAfterMs: 12_000,
  steerMessage:
    "STOP counting now. Do not run any more sleeps and do not output any more STEP lines. Instead output a single line exactly: DONE COUNTING — then stop.",
  verify(contents) {
    const text = contents.join("\n");
    const steps = (text.match(/\bstep\s+\d+/gi) || []).length; // informational — real agents paraphrase this
    const steerDelivered = /Steered mid-run/i.test(text);
    const acknowledged = /INTERRUPTED AT/i.test(text);
    const redirected = /DONE COUNTING/i.test(text);

    // The proof of mid-turn interrupt+redirect keys on the RELIABLE, one-shot
    // markers: the steer fired, the agent acknowledged it was interrupted mid-task
    // (naming where it was = context retained), and it followed the new instruction.
    // The per-step STEP count is brittle (agents paraphrase repetitive output), so
    // it's informational only — never gates the verdict.
    const checks: ScenarioCheck[] = [
      { label: "Steer was delivered to the running agent", pass: steerDelivered },
      { label: "Agent was interrupted mid-task with context (acknowledged where it was)", pass: acknowledged },
      { label: "Agent followed the redirect (emitted DONE COUNTING)", pass: redirected },
      { label: `Agent had started the task (${steps} step mention(s))`, pass: steps > 0 },
    ];
    if (!steerDelivered) return { checks, verdict: "pending" };
    const verdict = steerDelivered && acknowledged && redirected ? "pass" : "fail";
    return { checks, verdict };
  },
};

const OPEN_PR: Scenario = {
  name: "open-pr",
  description: "Write half: the agent clones a fixture repo, makes a tiny change, pushes a branch, and opens a draft PR.",
  repo: "https://github.com/tdenton8772/daboss-e2e-fixture",
  branchType: "docs",
  prompt: [
    "You are in a git repository. Make exactly ONE tiny change and nothing else:",
    "In calc.py, add a single comment line directly above `def add` that reads exactly:",
    "    # adds two numbers",
    "Do NOT change any logic, and do NOT touch any other file. Then you are done — stop.",
  ].join("\n"),
  verify(contents) {
    const text = contents.join("\n");
    const cloned = /Cloned|on new branch|continuing/i.test(text);
    const pushed = /Pushed branch/i.test(text);
    const pr = /(Opened|Updated) PR #\d+/i.test(text);
    const checks: ScenarioCheck[] = [
      { label: "Cloned the repo", pass: cloned },
      { label: "Pushed a branch", pass: pushed },
      { label: "Opened a draft PR", pass: pr },
    ];
    if (!pushed) return { checks, verdict: "pending" };
    return { checks, verdict: pr ? "pass" : "fail" };
  },
};

const TEST_GATES_PR: Scenario = {
  name: "test-gates-pr",
  description: "Write → verify: agent opens a PR, the test phase runs on the branch, and the PR is gated (comment + ready-on-green).",
  repo: "https://github.com/tdenton8772/daboss-e2e-fixture",
  branchType: "docs",
  autoTest: true,
  prompt: [
    "You are in a git repository. Make exactly ONE tiny change and nothing else:",
    "In calc.py, add a single comment line directly above `def multiply` that reads exactly:",
    "    # multiplies two numbers",
    "Do NOT change any logic or any test, and do NOT touch any other file. Then you are done — stop.",
  ].join("\n"),
  verify(contents, ctx) {
    const text = contents.join("\n");
    const prOpened = ctx?.prOpened || /(Opened|Updated) PR #\d+/i.test(text);
    const testRun = ctx?.pipelineRuns.find((r) => r.phase === "test");
    const testPassed = testRun?.status === "passed";
    const gated = !!testRun?.pr_posted;
    const checks: ScenarioCheck[] = [
      { label: "Agent opened a PR", pass: prOpened },
      { label: "Test phase ran on the branch", pass: !!testRun },
      { label: "Tests passed", pass: testPassed },
      { label: "PR gated (commented + marked ready)", pass: gated },
    ];
    if (!prOpened || !testRun || ["pending", "running"].includes(testRun.status)) {
      return { checks, verdict: "pending" };
    }
    return { checks, verdict: testPassed && gated ? "pass" : "fail" };
  },
};

export const scenarios: Record<string, Scenario> = {
  [MID_TURN_STEER.name]: MID_TURN_STEER,
  [OPEN_PR.name]: OPEN_PR,
  [TEST_GATES_PR.name]: TEST_GATES_PR,
};
