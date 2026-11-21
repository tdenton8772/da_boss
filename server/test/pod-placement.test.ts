import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as queries from "../src/db/queries.js";
import { LocalAesCipher, setCipher } from "../src/crypto/cipher.js";
import { parseNodeSelector, parseTolerations, podDefaults, workloadPodSpec } from "../src/agent/pod-spec.js";

// Every pod da_boss launches (agent, pipeline, image build, state cleanup) gets the
// cluster's placement (DABOSS_POD_NODE_SELECTOR / DABOSS_POD_TOLERATIONS) and pull
// secret (DABOSS_REGISTRY_SECRET), and no service-account token unless it runs as a
// named service account that needs the API.

// ── A fake cluster that records what da_boss creates ──────────────────────────
const k = vi.hoisted(() => ({
  pods: new Map<string, Record<string, any>>(),
  created: [] as Array<Record<string, any>>,
  secretLog: [] as Array<Record<string, string>>, // name + stringData of every Secret written // every pod body ever created (builds delete theirs)
  secrets: new Map<string, Record<string, any>>(),
  pvcs: new Set<string>(),
  registrySecrets: new Map<string, string>(), // name → dockerconfigjson
  buildPhase: "Succeeded",
}));
vi.mock("@kubernetes/client-node", () => {
  const notFound = () => Object.assign(new Error("not found"), { code: 404 });
  const core = {
    createNamespacedPod: async ({ body }: { body: any }) => { k.pods.set(body.metadata.name, body); k.created.push(body); },
    readNamespacedPod: async ({ name }: { name: string }) => {
      const p = k.pods.get(name);
      if (!p) throw notFound();
      return { ...p, status: { phase: name.startsWith("daboss-build-") ? k.buildPhase : undefined } };
    },
    deleteNamespacedPod: async ({ name }: { name: string }) => { k.pods.delete(name); },
    listNamespacedPod: async () => ({ items: [] }),
    createNamespacedSecret: async ({ body }: { body: any }) => {
      if (k.secrets.has(body.metadata.name)) throw Object.assign(new Error("exists"), { code: 409 });
      k.secrets.set(body.metadata.name, body); k.secretLog.push({ name: body.metadata.name, ...(body.stringData || {}) });
    },
    replaceNamespacedSecret: async ({ name, body }: { name: string; body: any }) => { k.secrets.set(name, body); },
    readNamespacedSecret: async ({ name }: { name: string }) => {
      const cfg = k.registrySecrets.get(name);
      if (cfg !== undefined) return { data: { ".dockerconfigjson": Buffer.from(cfg).toString("base64") } };
      if (k.secrets.has(name)) return k.secrets.get(name);
      throw notFound();
    },
    deleteNamespacedSecret: async ({ name }: { name: string }) => { k.secrets.delete(name); },
    readNamespacedPersistentVolumeClaim: async ({ name }: { name: string }) => {
      if (!k.pvcs.has(name)) throw notFound();
      return {};
    },
    createNamespacedPersistentVolumeClaim: async ({ body }: { body: any }) => { k.pvcs.add(body.metadata.name); },
    readNamespacedPodLog: async () => "",
  };
  class CoreV1Api {}
  class KubeConfig {
    loadFromCluster() {}
    makeApiClient() { return core; }
  }
  return { KubeConfig, CoreV1Api };
});

const { createAgentPod, launchPipelineRunner, launchStateCleanupPod } = await import("../src/agent/pod-dispatcher.js");
const { ensureImage, imageExists, DEFAULT_KANIKO_IMAGE, parseDockerConfig, credentialFor, parseWwwAuthenticate, registryApiHost, isGoogleRegistry } =
  await import("../src/agent/image-builder.js");

const POOL_ENV = {
  DABOSS_POD_NODE_SELECTOR: '{"pool":"agents"}',
  DABOSS_POD_TOLERATIONS: '[{"key":"pool","operator":"Equal","value":"agents","effect":"NoSchedule"}]',
  DABOSS_REGISTRY_SECRET: "regcred",
};
const ENV_KEYS = [...Object.keys(POOL_ENV)];
const KEY = Buffer.alloc(32, 7).toString("base64");

function setPoolEnv(): void { Object.assign(process.env, POOL_ENV); }
function clearPoolEnv(): void { for (const key of ENV_KEYS) delete process.env[key]; }

function expectPlacedNoToken(spec: any): void {
  expect(spec.nodeSelector).toEqual({ pool: "agents" });
  expect(spec.tolerations).toEqual([{ key: "pool", operator: "Equal", value: "agents", effect: "NoSchedule" }]);
  expect(spec.imagePullSecrets).toEqual([{ name: "regcred" }]);
  expect(spec.automountServiceAccountToken).toBe(false);
  expect(spec.serviceAccountName).toBeUndefined();
}

const agentBase = {
  name: "a", prompt: "p", cwd: "/work", state: "queued" as const,
  priority: "medium" as const, permission_mode: "default" as const,
  sdk_session_id: null, model: "claude-sonnet-5", max_turns: null,
  max_budget_usd: null, error_message: null, supervisor_instructions: "",
  permission_policy: "auto" as const, repo_url: null, repo_ref: null, branch: null,
  service_account: null, worker_image: null, adopted_ref: null,
};

beforeEach(() => {
  k.pods.clear(); k.created.length = 0; k.secretLog.length = 0; k.secrets.clear(); k.pvcs.clear(); k.registrySecrets.clear(); k.buildPhase = "Succeeded";
  clearPoolEnv();
});
afterEach(() => { clearPoolEnv(); vi.unstubAllGlobals(); setCipher(null); });

describe("pod-spec parsing", () => {
  it("parses a node selector object and rejects anything else", () => {
    expect(parseNodeSelector(undefined)).toEqual({});
    expect(parseNodeSelector("  ")).toEqual({});
    expect(parseNodeSelector('{"pool":"agents","zone":"a"}')).toEqual({ pool: "agents", zone: "a" });
    expect(() => parseNodeSelector("pool=agents")).toThrow(/JSON object/);
    expect(() => parseNodeSelector('["pool"]')).toThrow(/JSON object/);
    expect(() => parseNodeSelector('{"pool":1}')).toThrow(/must be a string/);
  });

  it("parses tolerations and rejects malformed ones (a silently dropped toleration strands pods)", () => {
    expect(parseTolerations("")).toEqual([]);
    expect(parseTolerations('[{"key":"pool","operator":"Exists","effect":"NoSchedule"}]'))
      .toEqual([{ key: "pool", operator: "Exists", effect: "NoSchedule" }]);
    expect(() => parseTolerations('{"key":"pool"}')).toThrow(/JSON array/);
    expect(() => parseTolerations('[{"key":"pool","operator":"In"}]')).toThrow(/Equal or Exists/);
    expect(() => parseTolerations('[{"key":"pool","effect":"Never"}]')).toThrow(/effect/);
    expect(() => parseTolerations('[{"key":"pool","valu":"x"}]')).toThrow(/unknown field/);
  });

  it("with nothing configured: no placement, no pull secret — and still no token", () => {
    const d = podDefaults({});
    expect(workloadPodSpec({}, d)).toEqual({ automountServiceAccountToken: false });
    expect(workloadPodSpec({ serviceAccount: "deployer" }, d))
      .toEqual({ serviceAccountName: "deployer", automountServiceAccountToken: true });
    expect(workloadPodSpec({ serviceAccount: "builder", apiToken: false }, d))
      .toEqual({ serviceAccountName: "builder", automountServiceAccountToken: false });
  });
});

describe("agent pods", () => {
  async function seedAgent(id: string, extra: Partial<typeof agentBase> = {}): Promise<void> {
    setCipher(new LocalAesCipher(KEY));
    await queries.createUser({ id: "usr_a", email: "a@x.io" }).catch(() => {});
    await queries.upsertUserCredential("usr_a", "anthropic_api_key", await new LocalAesCipher(KEY).encrypt("test-cred"));
    await queries.insertAgent({ ...agentBase, ...extra, id, created_by_user_id: "usr_a" });
  }

  it("run on the configured pool, pull with the registry secret, and get no k8s token", async () => {
    setPoolEnv();
    await seedAgent("ag_1");
    await createAgentPod("ag_1");
    const pod = k.pods.get("daboss-agent-ag-1")!;
    expectPlacedNoToken(pod.spec);
  });

  it("an agent with a named service account (deploy agent) runs as it, with its token", async () => {
    setPoolEnv();
    await seedAgent("ag_2", { service_account: "deployer" });
    await createAgentPod("ag_2");
    const spec = k.pods.get("daboss-agent-ag-2")!.spec;
    expect(spec.serviceAccountName).toBe("deployer");
    expect(spec.automountServiceAccountToken).toBe(true);
    expect(spec.nodeSelector).toEqual({ pool: "agents" });
  });

  it("without placement config the pod spec has none (unchanged behavior), token still off", async () => {
    await seedAgent("ag_3");
    await createAgentPod("ag_3");
    const spec = k.pods.get("daboss-agent-ag-3")!.spec;
    expect(spec.nodeSelector).toBeUndefined();
    expect(spec.tolerations).toBeUndefined();
    expect(spec.imagePullSecrets).toBeUndefined();
    expect(spec.automountServiceAccountToken).toBe(false);
  });
});

describe("pipeline and cleanup pods", () => {
  it("both pipeline pod layouts are placed, token-less by default, and token-bearing with service_account", async () => {
    setPoolEnv();
    await launchPipelineRunner({ runId: "r1", command: "make test", params: {}, secrets: {} });
    expectPlacedNoToken(k.pods.get("daboss-pl-r1")!.spec);
    await launchPipelineRunner({ runId: "r2", command: "make test", image: "reg.example/ci:1", params: {}, secrets: {} });
    expectPlacedNoToken(k.pods.get("daboss-pl-r2")!.spec);
    await launchPipelineRunner({ runId: "r3", command: "deploy", params: {}, secrets: {}, serviceAccount: "ci-deployer" });
    const spec = k.pods.get("daboss-pl-r3")!.spec;
    expect(spec.serviceAccountName).toBe("ci-deployer");
    expect(spec.automountServiceAccountToken).toBe(true);
    expect(spec.tolerations).toHaveLength(1);
  });

  it("a pinned sha: both layouts check out exactly that commit after the shallow clone", async () => {
    setPoolEnv();
    await launchPipelineRunner({ runId: "s1", repoUrl: "https://github.com/o/r", ref: "main", sha: "abc123", command: "t", image: "reg.example/ci:1", params: {}, secrets: {} });
    const clone = k.pods.get("daboss-pl-s1")!.spec.initContainers.find((c: any) => c.name === "clone");
    expect(clone.command[2]).toContain('fetch -q --depth 1 origin "$PIPELINE_SHA"');
    expect(clone.env).toContainEqual({ name: "PIPELINE_SHA", value: "abc123" });
    await launchPipelineRunner({ runId: "s2", repoUrl: "https://github.com/o/r", ref: "main", sha: "abc123", command: "t", params: {}, secrets: {} });
    expect(k.pods.get("daboss-pl-s2")!.spec.containers[0].env).toContainEqual({ name: "PIPELINE_SHA", value: "abc123" });
    await launchPipelineRunner({ runId: "s3", repoUrl: "https://github.com/o/r", ref: "main", command: "t", image: "reg.example/ci:1", params: {}, secrets: {} });
    expect(k.pods.get("daboss-pl-s3")!.spec.initContainers.find((c: any) => c.name === "clone").command[2]).not.toContain("PIPELINE_SHA");
  });

  it("the cleanup pod is placed too and keeps the boss SA token (it deletes itself)", async () => {
    setPoolEnv();
    k.pvcs.add("daboss-ws-usr-a");
    const ok = await launchStateCleanupPod({ ...agentBase, id: "ag_c", created_by_user_id: "usr_a" } as any);
    expect(ok).toBe(true);
    const spec = k.pods.get("daboss-cleanup-ag-c")!.spec;
    expect(spec.serviceAccountName).toBe("daboss");
    expect(spec.automountServiceAccountToken).toBe(true);
    expect(spec.nodeSelector).toEqual({ pool: "agents" });
    expect(spec.imagePullSecrets).toEqual([{ name: "regcred" }]);
  });
});

// ── Registry: kaniko builds and the "already built?" check ────────────────────

type Call = { url: string; method: string; auth: string | null };
function fakeRegistry(handler: (c: Call) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers || {}) as Record<string, string>;
    const c = { url: String(url), method: init.method || "GET", auth: headers.Authorization ?? null };
    calls.push(c);
    return handler(c);
  });
  return calls;
}
const dockerConfig = (host: string, user: string, pass: string) =>
  JSON.stringify({ auths: { [host]: { auth: Buffer.from(`${user}:${pass}`).toString("base64") } } });

describe("registry auth helpers", () => {
  it("reads dockerconfigjson auths (auth or username/password) keyed by bare host", () => {
    const auths = parseDockerConfig(JSON.stringify({ auths: {
      "https://index.docker.io/v1/": { auth: Buffer.from("u:p:with:colons").toString("base64") },
      "ghcr.io": { username: "bot", password: "tok" },
      "empty.example": {},
    } }));
    expect(auths).toEqual({ "index.docker.io": { username: "u", password: "p:with:colons" }, "ghcr.io": { username: "bot", password: "tok" } });
    expect(credentialFor(auths, "docker.io")).toEqual({ username: "u", password: "p:with:colons" });
    expect(credentialFor(auths, "quay.io")).toBeNull();
    expect(parseDockerConfig("not json")).toEqual({});
  });

  it("parses a bearer challenge and maps Docker Hub to its API host", () => {
    expect(parseWwwAuthenticate('Bearer realm="https://auth.example/token",service="reg.example",scope="repository:t/a:pull"'))
      .toEqual({ scheme: "bearer", params: { realm: "https://auth.example/token", service: "reg.example", scope: "repository:t/a:pull" } });
    expect(parseWwwAuthenticate(null)).toBeNull();
    expect(registryApiHost("docker.io")).toBe("registry-1.docker.io");
    expect(registryApiHost("ghcr.io")).toBe("ghcr.io");
  });

  it("knows which hosts a cloud token may be sent to", () => {
    expect(isGoogleRegistry("us-central1-docker.pkg.dev")).toBe(true);
    expect(isGoogleRegistry("gcr.io")).toBe(true);
    expect(isGoogleRegistry("eu.gcr.io")).toBe(true);
    expect(isGoogleRegistry("ghcr.io")).toBe(false);
    expect(isGoogleRegistry("evil-docker.pkg.dev.example.com")).toBe(false);
    expect(isGoogleRegistry("notgcr.io")).toBe(false);
  });
});

describe("imageExists with the registry secret", () => {
  it("answers a Bearer challenge with the secret's credentials (token exchange), never a cloud token", async () => {
    process.env.DABOSS_REGISTRY_SECRET = "regcred-bearer";
    k.registrySecrets.set("regcred-bearer", dockerConfig("reg.example", "bot", "s3cret"));
    const calls = fakeRegistry((c) => {
      if (c.url.startsWith("https://auth.example/token")) return new Response(JSON.stringify({ token: "tkn" }), { status: 200 });
      if (c.auth === "Bearer tkn") return new Response(null, { status: 200 });
      return new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="https://auth.example/token",service="reg.example",scope="repository:team/app:pull"' } });
    });
    expect(await imageExists("reg.example/team/app:v1")).toBe(true);
    const tokenCall = calls.find((c) => c.url.startsWith("https://auth.example/token"))!;
    expect(tokenCall.auth).toBe(`Basic ${Buffer.from("bot:s3cret").toString("base64")}`);
    expect(tokenCall.url).toContain("scope=repository%3Ateam%2Fapp%3Apull");
    expect(calls.some((c) => c.url.includes("metadata.google.internal"))).toBe(false);
  });

  it("answers a Basic challenge directly, and a 404 means not built", async () => {
    process.env.DABOSS_REGISTRY_SECRET = "regcred-basic";
    k.registrySecrets.set("regcred-basic", dockerConfig("https://reg.example", "bot", "pw"));
    fakeRegistry((c) => c.auth ? new Response(null, { status: 404 }) : new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Basic realm="reg"' } }));
    expect(await imageExists("reg.example/team/app:v2")).toBe(false);
  });

  it("without a secret a 401 stays inconclusive → build (safe), no token request", async () => {
    const calls = fakeRegistry(() => new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="https://auth.example/token"' } }));
    expect(await imageExists("reg.example/team/app:v3")).toBe(false);
    expect(calls.filter((c) => c.url.startsWith("https://auth.example"))).toEqual([]);
  });
});

describe("kaniko build pods", () => {
  it("pinned executor, placed, no k8s token, registry secret mounted as kaniko's docker config", async () => {
    setPoolEnv();
    k.registrySecrets.set("regcred", dockerConfig("reg.example", "bot", "pw"));
    fakeRegistry(() => new Response(null, { status: 404 })); // not built yet
    await ensureImage("reg.example/team/ci:abc", { context: "." }, { repoUrl: "https://github.com/o/r", gitToken: "g1t-t0ken-value" });
    const pod = k.created.find((p) => p.metadata.labels?.app === "daboss-build")!;
    expect(pod).toBeTruthy();
    expect(k.pods.has(pod.metadata.name)).toBe(false); // cleaned up after Succeeded
    expectPlacedNoToken(pod.spec);
    const c = pod.spec.containers[0];
    expect(c.image).toBe(DEFAULT_KANIKO_IMAGE);
    expect(DEFAULT_KANIKO_IMAGE).toMatch(/^gcr\.io\/kaniko-project\/executor:v[\d.]+@sha256:[0-9a-f]{64}$/);
    expect(c.volumeMounts).toEqual([{ name: "registry-auth", mountPath: "/kaniko/.docker", readOnly: true }]);
    expect(pod.spec.volumes).toEqual([{ name: "registry-auth", secret: { secretName: "regcred", items: [{ key: ".dockerconfigjson", path: "config.json" }] } }]);
    expect(c.args).toContain("--destination=reg.example/team/ci:abc");
    // the git token is never a literal in the pod spec: it comes from the per-build Secret
    expect(JSON.stringify(pod)).not.toContain("g1t-t0ken-value");
    expect(c.env).toContainEqual({ name: "GIT_PASSWORD", valueFrom: { secretKeyRef: { name: `${pod.metadata.name}-git`, key: "GIT_PASSWORD" } } });
    expect(k.secretLog).toContainEqual({ name: `${pod.metadata.name}-git`, GIT_PASSWORD: "g1t-t0ken-value" });
    expect(k.secrets.has(`${pod.metadata.name}-git`)).toBe(false); // deleted with the pod
  });
});
