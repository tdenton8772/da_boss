/**
 * Load the target repo's OWN MCP servers from its `.mcp.json`, so a da_boss agent
 * gets whatever tools the repo provides — a memory / knowledge-base server, a
 * schema oracle, whatever — and can follow the repo's own rules (e.g. "search the
 * knowledge base before touching credentials"). Without this, the SDK never starts
 * the repo's servers, so every `mcp_tool` hook the repo defines is a silent no-op.
 *
 * da_boss stays NEUTRAL: it runs whatever `.mcp.json` declares and knows nothing
 * about any specific server. The repo owns correctness (portable paths, reachable
 * backends). Command hooks (`.claude/settings.json` PreToolUse guards, etc.) already
 * fire via `settingSources: ['project']` — this only fills the MCP-server gap.
 *
 * SECURITY: starting these servers executes the repo's code. Callers MUST NOT load
 * them for a review of untrusted/fork code — that would run the fork's commands.
 */
import { readFile } from "node:fs/promises";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

/** The `mcpServers` map from `<workDir>/.mcp.json`, or `{}` if the file is absent,
 *  empty, or unparseable. Best-effort — never throws. */
export async function loadRepoMcpServers(workDir: string): Promise<Record<string, McpServerConfig>> {
  try {
    const raw = await readFile(`${workDir}/.mcp.json`, "utf8").catch(() => "");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, McpServerConfig> };
    const servers = parsed?.mcpServers;
    return servers && typeof servers === "object" ? servers : {};
  } catch {
    // Malformed JSON etc. — don't fail the agent over the repo's config; just run
    // without the repo's servers (CLAUDE.md + command hooks still apply).
    return {};
  }
}
