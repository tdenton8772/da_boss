import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// distributed-plan §9.1 Axis 2: the five core components (scheduler, lease
// manager, intent store, merge queue, lifecycle) must not see software-
// development-workflow concepts (git/PR/branch/merge/diff/file). Today the only
// core surface is the schema, so we assert the CORE tables carry no such
// vocabulary — it lives ONLY in the adapter table dev_delta_materialization.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsSrc = readFileSync(
  path.resolve(__dirname, "../src/db/migrations.ts"),
  "utf8"
);

const CORE_TABLES = ["leases", "intents"];
const FORBIDDEN = [
  "branch", "pr_number", "pull_request", "github", "merge", "commit",
  "file_path", "diff", "repo", "phoenix", "pgvector", "rabbitmq", "region",
];

/** Column-definition body of a CREATE TABLE, with `--` comment lines stripped
 *  (so explanatory prose like "never a pr_id" isn't scanned as schema). */
function tableBody(src: string, name: string): string {
  const start = src.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`);
  if (start === -1) throw new Error(`table ${name} not found in migrations`);
  const end = src.indexOf(");", start);
  return src
    .slice(start, end)
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .toLowerCase();
}

describe("schema neutrality (plan §9.1 Axis 2)", () => {
  for (const table of CORE_TABLES) {
    it(`core table '${table}' has no dev-workflow vocabulary`, () => {
      const body = tableBody(migrationsSrc, table);
      const hits = FORBIDDEN.filter((w) => body.includes(w));
      expect(
        hits,
        `core table '${table}' leaks dev-workflow concepts: ${hits.join(", ")} — move them behind the dev_delta_materialization adapter`
      ).toEqual([]);
    });
  }

  it("the adapter table IS where git/PR concepts live", () => {
    const body = tableBody(migrationsSrc, "dev_delta_materialization");
    expect(body).toContain("pr_number");
    expect(body).toContain("branch");
  });
});
