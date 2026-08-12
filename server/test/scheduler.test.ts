import { describe, it, expect } from "vitest";
import { isNightlyDue } from "../src/pipeline/scheduler.js";
import { parsePipeline } from "../src/pipeline/config.js";
import * as queries from "../src/db/queries.js";

// Scheduled phases: the repo declares WHAT (a snapshot command), the boss owns
// WHEN (nightly), and downstream phases consume the artifact via artifact_from.

describe("isNightlyDue — interval-with-slack, no run-storms, no drift", () => {
  const now = new Date("2026-08-12T03:00:00Z");

  it("due when never run or the record is garbage", () => {
    expect(isNightlyDue(null, now)).toBe(true);
    expect(isNightlyDue("not-a-date", now)).toBe(true);
  });

  it("not due again shortly after a launch", () => {
    expect(isNightlyDue("2026-08-12T02:50:00Z", now)).toBe(false);
    expect(isNightlyDue("2026-08-11T10:00:00Z", now)).toBe(false); // 17h — same night
  });

  it("due after ~a day; the 2h slack stops nightly drift", () => {
    expect(isNightlyDue("2026-08-11T03:05:00Z", now)).toBe(true); // 23h55m — tonight's run
    expect(isNightlyDue("2026-08-10T03:00:00Z", now)).toBe(true); // missed a night
  });
});

describe("pipeline config — schedule + artifact_from", () => {
  it("parses a snapshot/seed pair", () => {
    const p = parsePipeline(`
phases:
  snapshot:
    command: ./scripts/make-snapshot.sh
    schedule: nightly
  test-elixir:
    command: psql -f $DABOSS_SEED && mix test
    artifact_from: snapshot
`);
    expect(p.phases.snapshot.schedule).toBe("nightly");
    expect(p.phases["test-elixir"].artifact_from).toBe("snapshot");
  });

  it("rejects unknown schedule values", () => {
    expect(() => parsePipeline(`phases:\n  s:\n    command: x\n    schedule: hourly\n`))
      .toThrow(/schedule must be "nightly"/);
  });

  it("rejects artifact_from naming a phase that doesn't exist", () => {
    expect(() => parsePipeline(`phases:\n  t:\n    command: x\n    artifact_from: ghost\n`))
      .toThrow(/unknown phase 'ghost'/);
  });
});

describe("getLatestPassedArtifact — the seed a phase consumes", () => {
  async function run(id: string, over: { status?: string; artifact?: string | null; repo?: string }) {
    await queries.insertPipelineRun({
      id, repoUrl: over.repo ?? "https://github.com/o/r.git", ref: "main", phase: "snapshot",
      status: "pending", createdByUserId: null, agentId: null,
    });
    await queries.updatePipelineRun(id, {
      status: over.status ?? "passed",
      artifact: over.artifact === undefined ? "SEED" : over.artifact ?? undefined,
      completed: true,
    });
  }

  it("returns the newest PASSED run with an artifact, matching both URL forms", async () => {
    await run("run_old", { artifact: "OLD" });
    await run("run_fail", { status: "failed", artifact: "BROKEN" });
    await run("run_new", { artifact: "NEW", repo: "https://github.com/o/r" }); // bare form
    const got = await queries.getLatestPassedArtifact("https://github.com/o/r.git", "snapshot");
    expect(got?.artifact).toBe("NEW");
  });

  it("undefined when the phase never passed", async () => {
    await run("run_f1", { status: "failed" });
    expect(await queries.getLatestPassedArtifact("https://github.com/o/r.git", "snapshot")).toBeUndefined();
  });
});
