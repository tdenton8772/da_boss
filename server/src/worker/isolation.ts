/**
 * What of the REPO's own Claude Code configuration an agent's SDK session may
 * load — the trust boundary between da_boss and the code it works on.
 *
 *  - MCP servers: only the ones the worker passes explicitly (`strictMcpConfig`).
 *    Since CLI 2.1 the SDK auto-starts every server in a repo's .mcp.json even
 *    with no approval setting — which would run repo code in a review pod. The
 *    worker loads .mcp.json itself, and only for non-review agents.
 *  - Project settings (`.claude/settings.json`: hooks, permissions): loaded for
 *    agents doing the repo's own work — its guard hooks should fire — but NOT for
 *    review agents. A hook is a command; a fork PR's settings would otherwise run
 *    the PR's code the moment its review starts. (The repo's CLAUDE.md still
 *    reaches reviewers: the worker injects it into the system prompt itself.)
 */
export function repoConfigOptions(isReview: boolean): { settingSources: Array<"project">; strictMcpConfig: true } {
  return { settingSources: isReview ? [] : ["project"], strictMcpConfig: true };
}
