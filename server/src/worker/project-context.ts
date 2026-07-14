/**
 * Load the repo's CLAUDE.md (+ flag the .claude/ dir) so the worker can inject it
 * into the agent's system prompt.
 *
 * Why we do this ourselves: the Agent SDK's `settingSources: ['project']` is
 * documented to load CLAUDE.md, and the `--setting-sources project` flag IS passed
 * to the CLI — but CLI 2.0.77 does NOT honor it for CLAUDE.md in print/stream mode
 * (verified in-pod: the file is on disk and the flag is set, yet none of its content
 * reaches the model). So we read it and inject it explicitly — version-proof.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

/** Returns a system-prompt fragment carrying the repo's CLAUDE.md, or "" if there
 *  is none. Best-effort — never throws (context loading must not fail the agent). */
export async function loadProjectContext(workDir: string): Promise<string> {
  try {
    const md = await readFile(`${workDir}/CLAUDE.md`, "utf8").catch(() => "");
    if (!md.trim()) return "";
    let ctx =
      `\n\n=== PROJECT INSTRUCTIONS — from the repo's CLAUDE.md. These are authoritative project conventions; follow them. ===\n` +
      md.slice(0, 40_000) +
      `\n=== end of CLAUDE.md ===`;
    if (existsSync(`${workDir}/.claude`)) {
      ctx += `\n\nThis repo also has a .claude/ directory (skills, settings, memory) — read the relevant files there when a task calls for it.`;
    }
    return ctx;
  } catch {
    return "";
  }
}
