import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepoMcpServers } from "../src/worker/repo-mcp.js";

// da_boss loads whatever MCP servers the target repo declares in .mcp.json so the
// agent gets the repo's tools (memory/knowledge base, etc.). Neutral: it parses and
// passes through; it knows nothing about any specific server.

describe("loadRepoMcpServers — pass through the repo's .mcp.json", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "daboss-mcp-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("returns the mcpServers map declared by the repo", async () => {
    await writeFile(join(dir, ".mcp.json"), JSON.stringify({
      mcpServers: {
        "repo-memory": {
          type: "stdio",
          command: "python3",
          args: ["${CLAUDE_PROJECT_DIR}/workers/mcp/memory_server.py"],
          env: { FASTEMBED_CACHE_PATH: "/opt/fastembed" },
        },
      },
    }));
    const servers = await loadRepoMcpServers(dir);
    expect(Object.keys(servers)).toEqual(["repo-memory"]);
    const s = servers["repo-memory"] as { command: string; args: string[]; env: Record<string, string> };
    expect(s.command).toBe("python3");
    expect(s.args[0]).toContain("memory_server.py");
    expect(s.env.FASTEMBED_CACHE_PATH).toBe("/opt/fastembed");
  });

  it("returns {} when there is no .mcp.json", async () => {
    expect(await loadRepoMcpServers(dir)).toEqual({});
  });

  it("returns {} for a .mcp.json with no mcpServers key", async () => {
    await writeFile(join(dir, ".mcp.json"), JSON.stringify({ other: true }));
    expect(await loadRepoMcpServers(dir)).toEqual({});
  });

  it("returns {} for malformed JSON (never throws — don't fail the agent)", async () => {
    await writeFile(join(dir, ".mcp.json"), "{ not valid json ");
    expect(await loadRepoMcpServers(dir)).toEqual({});
  });

  it("passes through multiple servers untouched (neutral)", async () => {
    await writeFile(join(dir, ".mcp.json"), JSON.stringify({
      mcpServers: { a: { command: "x" }, b: { type: "sse", url: "http://h/sse" } },
    }));
    expect(Object.keys(await loadRepoMcpServers(dir)).sort()).toEqual(["a", "b"]);
  });
});
