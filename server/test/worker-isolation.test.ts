import { describe, it, expect } from "vitest";
import { repoConfigOptions } from "../src/worker/isolation.js";

// The trust boundary between da_boss and the repo an agent works on. Verified
// against the real CLI (2.1.x): without strictMcpConfig it auto-starts every
// server in the repo's .mcp.json; with settingSources ["project"] it runs the
// repo's hooks. A review agent of a fork PR must do neither.
describe("repo config isolation", () => {
  it("never lets the CLI auto-load MCP servers — for any agent", () => {
    expect(repoConfigOptions(false).strictMcpConfig).toBe(true);
    expect(repoConfigOptions(true).strictMcpConfig).toBe(true);
  });
  it("loads the repo's settings (hooks, permissions) for its own agents only", () => {
    expect(repoConfigOptions(false).settingSources).toEqual(["project"]);
    expect(repoConfigOptions(true).settingSources).toEqual([]);
  });
});
