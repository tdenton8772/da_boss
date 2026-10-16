import { describe, it, expect } from "vitest";
import { parseDevConfig, renderTemplate } from "../src/dev/config.js";
import { buildDevDeployment, devEnvName, devCommands, localClaudePrompt, bootstrapScript, syncScript, shq } from "../src/dev/manifest.js";

// A realistic declaration: a web app with a DB proxy sidecar, secrets, an
// impersonated dev user — everything app-specific lives here, none in da_boss.
const FULL = `
namespace: shop
port: 4000
workdir: web
image: agent
service_account: shop-app-sa
pod_annotations: { iam.gke.io/gcp-service-account: shop@proj.iam.gserviceaccount.com }
node_selector: { pool: app }
tolerations: [{ key: pool, value: app, operator: Equal, effect: NoSchedule }]
env_from: [{ config_map: shop-config }, { secret: shop-secrets }]
secret_env: [{ name: DATABASE_URL, secret: shop-db, key: DATABASE_URL }]
env:
  DEV_SKIP_AUTH: "true"
  DEV_USER_EMAIL: \${user.email}
  BRANCH: \${branch}
sidecars:
  - name: db-proxy
    image: gcr.io/cloud-sql-connectors/cloud-sql-proxy:2
    args: ["--port=5432"]
resources: { requests: { cpu: 500m, memory: 1Gi }, limits: { memory: 4Gi } }
setup: ["mix compile"]
start: mix phx.server
sync: mix compile
ready_check: curl -sf localhost:4000
ttl_hours: 6
sync_exclude: [web/_build, web/deps]
`;

describe("dev.yaml contract", () => {
  it("parses a full declaration", () => {
    const c = parseDevConfig(FULL);
    expect(c).toMatchObject({
      namespace: "shop", port: 4000, workdir: "web", image: "agent", service_account: "shop-app-sa",
      setup: ["mix compile"], start: "mix phx.server", sync: ["mix compile"], ttl_hours: 6, restart_on_sync: false,
    });
    expect(c.secret_env).toEqual([{ name: "DATABASE_URL", secret: "shop-db", key: "DATABASE_URL" }]);
    expect(c.env_from).toEqual([{ config_map: "shop-config" }, { secret: "shop-secrets" }]);
  });

  it("applies defaults for a minimal declaration", () => {
    const c = parseDevConfig("namespace: demo\nport: 8080\nstart: npm run dev\n");
    expect(c).toMatchObject({ image: "agent", workdir: ".", setup: [], sync: [], ttl_hours: 8, ready_timeout_seconds: 600 });
  });

  it.each([
    ["port: 4000\nstart: x", /namespace/],
    ["namespace: Bad_NS\nport: 4000\nstart: x", /valid Kubernetes name/],
    ["namespace: d\nport: 99999\nstart: x", /port/],
    ["namespace: d\nport: 1\n", /start/],
    ["namespace: d\nport: 1\nstart: x\nworkdir: ../escape", /inside the repo/],
    ["namespace: d\nport: 1\nstart: x\nworkdir: /etc", /inside the repo/],
    ["namespace: d\nport: 1\nstart: x\nsidecars: [{ name: dev, image: i }]", /can't be named 'dev'/],
    ["namespace: d\nport: 1\nstart: x\nsidecars: [{ name: s }]", /image/],
    ["namespace: d\nport: 1\nstart: x\nenv_from: [{ nope: x }]", /config_map/],
    ["namespace: d\nport: 1\nstart: x\nttl_hours: 500", /ttl_hours/],
    ["namespace: d\nport: 1\nstart: x\nenv: { 1BAD: v }", /env name/],
    ["- not a map", /top level/],
  ])("rejects %j", (yaml, err) => {
    expect(() => parseDevConfig(yaml)).toThrow(err);
  });

  it("renders template vars and leaves unknown ones alone", () => {
    const vars = { "user.email": "a@b.co", "user.name": "A", branch: "feat/x", repo: "r" };
    expect(renderTemplate("${user.email} on ${branch} ${nope}", vars)).toBe("a@b.co on feat/x ${nope}");
  });
});

describe("dev Deployment", () => {
  const c = parseDevConfig(FULL);
  const dep = buildDevDeployment({
    name: "dev-alice-ag-1", image: "reg/agent-shop:abc", config: c, envId: "dev_1", agentId: "ag_1",
    vars: { "user.email": "alice@co.io", "user.name": "Alice", branch: "feat/x", repo: "https://github.com/o/shop" },
  });
  const pod = dep.spec!.template.spec!;
  const dev = pod.containers[0];

  it("runs an idle dev container (da_boss execs setup/start into it) plus the declared sidecars", () => {
    expect(dep.metadata).toMatchObject({ name: "dev-alice-ag-1", namespace: "shop" });
    expect(dev).toMatchObject({ name: "dev", image: "reg/agent-shop:abc", command: ["sleep", "infinity"], ports: [{ containerPort: 4000 }] });
    expect(pod.containers.map((x) => x.name)).toEqual(["dev", "db-proxy"]);
    expect(pod).toMatchObject({ serviceAccountName: "shop-app-sa", nodeSelector: { pool: "app" } });
    expect(dep.spec!.template.metadata!.annotations).toEqual({ "iam.gke.io/gcp-service-account": "shop@proj.iam.gserviceaccount.com" });
    expect(dep.spec!.selector.matchLabels).toEqual({ app: "dev-alice-ag-1" });
  });

  it("renders env (templated), secret refs and envFrom", () => {
    expect(dev.env).toEqual(expect.arrayContaining([
      { name: "DEV_USER_EMAIL", value: "alice@co.io" },
      { name: "BRANCH", value: "feat/x" },
      { name: "DATABASE_URL", valueFrom: { secretKeyRef: { name: "shop-db", key: "DATABASE_URL" } } },
    ]));
    expect(dev.envFrom).toEqual([{ configMapRef: { name: "shop-config" } }, { secretRef: { name: "shop-secrets" } }]);
  });

  it("names are readable, unique per change, and valid DNS labels", () => {
    expect(devEnvName("ag_GXeCi7Ua", "paul.preuveneers@scylladb.com")).toBe("dev-paul-preuveneers-ag-gxeci7ua");
    const long = devEnvName("ag_x".repeat(20), "a".repeat(80) + "@x.io");
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
  });
});

describe("in-pod scripts", () => {
  const c = parseDevConfig(FULL);
  it("never put the git token in the script — it's read from stdin", () => {
    for (const s of [bootstrapScript("https://github.com/o/shop", "feat/x", c), syncScript("feat/x", c)]) {
      expect(s).toContain("IFS= read -r DABOSS_GIT_TOKEN");
      expect(s).not.toMatch(/ghp_|x-access-token:[^ ]*@/);
    }
  });
  it("quotes branch names and commands", () => {
    expect(shq("it's")).toBe(`'it'\\''s'`);
    expect(bootstrapScript("https://x/r", "feat/a;rm -rf /", c)).toContain(`'feat/a;rm -rf /'`);
  });
  it("only restarts on sync when the repo asks", () => {
    expect(syncScript("b", c)).not.toContain("kill -TERM");
    expect(syncScript("b", { ...c, restart_on_sync: true })).toContain("kill -TERM");
  });
  it("kills the app's whole process group in a form dash accepts, and waits for it", () => {
    const s = syncScript("b", { ...c, restart_on_sync: true });
    expect(s).toContain('kill -TERM "-$P"');
    expect(s).not.toMatch(/kill -\w+ -- /); // dash: "Illegal number: -" → the old server survives
    expect(s).toContain('kill -0 "-$P"');
    expect(s).toContain('kill -KILL "-$P"');
  });
});

describe("what the human gets", () => {
  it("an exact port-forward when the deployment names its kubectl context", () => {
    const cmds = devCommands({ name: "dev-a-1", namespace: "shop", port: 4000, branch: "feat/x", context: "gw_ctx", syncExclude: ["web/_build"] });
    expect(cmds.port_forward).toBe("kubectl --context gw_ctx -n shop port-forward deploy/dev-a-1 4000:4000");
    expect(cmds.copy_tree).toContain("--exclude='.git' --exclude='web/_build'");
    expect(cmds.copy_tree).toContain("exec -i deploy/dev-a-1 -c dev -- tar -xzf - -C /workspace/src");
    expect(cmds.context_hint).toBeUndefined();
  });
  it("a $CTX placeholder plus a hint otherwise", () => {
    const cmds = devCommands({ name: "d", namespace: "n", port: 1, branch: "b", syncExclude: [] });
    expect(cmds.port_forward).toContain("--context $CTX");
    expect(cmds.context_hint).toMatch(/CTX/);
  });
  it("a local-Claude prompt naming the branch and the MCP tools to call", () => {
    const cmds = devCommands({ name: "d", namespace: "n", port: 4000, branch: "feat/x", context: "c", syncExclude: [] });
    const p = localClaudePrompt({ agentId: "ag_1", agentName: "Fix totals", repoUrl: "https://github.com/o/r", branch: "feat/x", cmds });
    expect(p).toContain("git fetch origin feat/x && git checkout feat/x");
    expect(p).toContain(cmds.port_forward);
    for (const tool of ["sync_dev_env", "handback_change", "stop_dev_env"]) expect(p).toContain(tool);
  });
});

describe("local-Claude prompt without MCP + with files", () => {
  const cmds = devCommands({ name: "d", namespace: "n", port: 4000, branch: "feat/x", context: "c", syncExclude: [] });
  it("falls back to asking the human to click when the MCP tools aren't connected", () => {
    const p = localClaudePrompt({ agentId: "ag_1", agentName: "x", repoUrl: "r", branch: "feat/x", cmds });
    expect(p).toMatch(/sync_dev_env.*if you have it; otherwise ask me to click \*\*Sync\*\*/s);
    expect(p).toMatch(/handback_change.*otherwise ask me to click \*\*Hand back\*\*/s);
    expect(p).not.toContain("Files attached");
  });
  it("lists the change's uploaded files and how to read them", () => {
    const p = localClaudePrompt({ agentId: "ag_1", agentName: "x", repoUrl: "r", branch: "feat/x", cmds, files: ["bug.png", "spec.pdf"] });
    expect(p).toContain("Files attached to the change (screenshots/docs): bug.png, spec.pdf");
    expect(p).toContain("read_agent_file");
  });
});
