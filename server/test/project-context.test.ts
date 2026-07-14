import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectContext } from "../src/worker/project-context.js";

// The worker injects the repo's CLAUDE.md itself because CLI 2.0.77 ignores
// settingSources:["project"] for CLAUDE.md in print mode. These lock in that the
// content is actually picked up (the bug: agents were running with zero of it).

describe("loadProjectContext — inject the repo's CLAUDE.md", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "daboss-pc-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("returns the CLAUDE.md content wrapped as authoritative project instructions", async () => {
    await writeFile(join(dir, "CLAUDE.md"), "# Odyssey — Claude Code Context\nAlways run `mix test`.");
    const ctx = await loadProjectContext(dir);
    expect(ctx).toContain("PROJECT INSTRUCTIONS");
    expect(ctx).toContain("Odyssey — Claude Code Context");
    expect(ctx).toContain("mix test");
    expect(ctx).toContain("end of CLAUDE.md");
  });

  it("notes the .claude/ directory when present", async () => {
    await writeFile(join(dir, "CLAUDE.md"), "conventions");
    await mkdir(join(dir, ".claude"));
    expect(await loadProjectContext(dir)).toContain(".claude/ directory");
  });

  it("does NOT mention .claude/ when it's absent", async () => {
    await writeFile(join(dir, "CLAUDE.md"), "conventions");
    expect(await loadProjectContext(dir)).not.toContain(".claude/ directory");
  });

  it("returns empty string when there is no CLAUDE.md (no project instructions to inject)", async () => {
    expect(await loadProjectContext(dir)).toBe("");
  });

  it("returns empty for a CLAUDE.md that is only whitespace", async () => {
    await writeFile(join(dir, "CLAUDE.md"), "   \n  \n");
    expect(await loadProjectContext(dir)).toBe("");
  });

  it("caps very large CLAUDE.md content", async () => {
    await writeFile(join(dir, "CLAUDE.md"), "x".repeat(60_000));
    const ctx = await loadProjectContext(dir);
    expect(ctx.length).toBeLessThan(41_000);
  });
});
