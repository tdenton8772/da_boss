import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import session from "express-session";
import request from "supertest";
import { EventEmitter } from "node:events";

// The CLI is never spawned in tests: the catalog fetch goes through this fake.
const sdk = vi.hoisted(() => ({
  supportedModels: async (): Promise<unknown[]> => [],
  lastOptions: null as Record<string, unknown> | null,
}));
// The Models API source: an async-iterable page of ModelInfo-shaped rows.
const api = vi.hoisted(() => ({
  models: [] as unknown[],
  fail: null as Error | null,
  lastOptions: null as Record<string, unknown> | null,
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    constructor(opts: Record<string, unknown>) { api.lastOptions = opts; }
    models = {
      list: () => (async function* () {
        if (api.fail) throw api.fail;
        yield* api.models;
      })(),
    };
  },
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ options }: { options: Record<string, unknown> }) => {
    sdk.lastOptions = options;
    return { supportedModels: () => sdk.supportedModels(), close: () => {} };
  },
}));

import * as queries from "../src/db/queries.js";
import { LocalAesCipher, setCipher } from "../src/crypto/cipher.js";
import { SUPERVISOR_CRED_SETTING } from "../src/supervisor/credential.js";
import { AgentManager } from "../src/agent/manager.js";
import { createRouter } from "../src/api/router.js";
import { buildReviewConfig } from "../src/pipeline/review-logic.js";
import type { AgentRecord } from "../src/types/agent.js";
import {
  validateModelChoice, findModel, mergeCatalogSources, knownEffortLevels, catalogIsStale, getModelCatalog, refreshModelCatalog,
  getModelDefaults, resolveRole, sdkModelOptions, installedSdkVersion, DEFAULTS_SETTING, type ModelCatalog,
} from "../src/models.js";

const KEY = Buffer.alloc(32, 7).toString("base64");

/** Shaped like a real `supportedModels()` reply: aliases + pinned ids. */
const LIVE_MODELS = [
  { value: "default", resolvedModel: "claude-opus-9", displayName: "Default (recommended)", description: "", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "opus", resolvedModel: "claude-opus-9", displayName: "Opus 9", description: "", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "sonnet", resolvedModel: "claude-sonnet-9", displayName: "Sonnet 9", description: "", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "claude-opus-4-6", resolvedModel: "claude-opus-4-6", displayName: "Opus 4.6", description: "", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "max"] },
  { value: "claude-haiku-4-5-20251001", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "" },
];
/** Shaped like `GET /v1/models` rows (capabilities.effort keyed by level). */
const lvl = (...ls: string[]) => Object.fromEntries([["supported", ls.length > 0], ...["low", "medium", "high", "xhigh", "max"].map((l) => [l, { supported: ls.includes(l) }])]);
const API_MODELS = [
  { id: "claude-opus-9", display_name: "Claude Opus 9", lifecycle: "active", capabilities: { effort: lvl("low", "medium", "high", "xhigh", "max") } },
  { id: "claude-opus-4-6", display_name: "Claude Opus 4.6", lifecycle: "deprecated", capabilities: { effort: lvl("low", "medium", "high", "max") } },
  { id: "claude-sonnet-3", display_name: "Claude Sonnet 3", lifecycle: "retired", capabilities: { effort: lvl() } },
  { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", lifecycle: "active", capabilities: { effort: lvl() } },
];
const live = (): ModelCatalog => ({ source: "live", models: LIVE_MODELS as ModelCatalog["models"], fetched_at: new Date().toISOString(), sdk_version: installedSdkVersion(), format: 2 });
const seed = (): ModelCatalog => ({ source: "seed", models: [{ value: "opus", displayName: "Opus", description: "" }], fetched_at: null, sdk_version: null });

async function designateSupervisor() {
  await queries.createUser({ id: "usr_sup", email: "sup@x.io" });
  await queries.upsertUserCredential("usr_sup", "anthropic_api_key", await new LocalAesCipher(KEY).encrypt("test-cred"));
  await queries.setAppSetting(SUPERVISOR_CRED_SETTING, "usr_sup");
}

beforeEach(() => {
  setCipher(new LocalAesCipher(KEY));
  delete process.env.DABOSS_MODEL_DEFAULTS;
  delete process.env.SUPERVISOR_CREDENTIAL_USER;
  sdk.supportedModels = async () => LIVE_MODELS;
  sdk.lastOptions = null;
  api.models = [];
  api.fail = null;
  api.lastOptions = null;
});
afterEach(() => {
  setCipher(null);
  delete process.env.DABOSS_MODEL_DEFAULTS;
});

describe("model validation", () => {
  it("accepts catalog ids, aliases, an alias's resolved id, and unlisted id-shaped models", () => {
    expect(validateModelChoice(live(), "opus", null)).toBeNull();
    expect(validateModelChoice(live(), "claude-opus-4-6", null)).toBeNull();
    expect(validateModelChoice(live(), "claude-sonnet-9", null)).toBeNull(); // what 'sonnet' resolves to
    // The catalog is the supervisor's view — an unlisted pinned id may still work for the agent's owner.
    expect(validateModelChoice(live(), "claude-sonnet-5", "high")).toBeNull();
    expect(validateModelChoice(live(), "not a model!", null)).toMatch(/doesn't look like a model/);
  });

  it("checks effort against what the model supports", () => {
    expect(validateModelChoice(live(), "opus", "xhigh")).toBeNull();
    expect(validateModelChoice(live(), "claude-opus-4-6", "xhigh")).toMatch(/Opus 4.6 supports effort low, medium, high, max/);
    expect(validateModelChoice(live(), "claude-haiku-4-5-20251001", "low")).toMatch(/doesn't support effort/);
    expect(validateModelChoice(live(), "opus", "turbo")).toMatch(/Invalid effort/);
  });

  it("with only the seed, allows any id-shaped model (the CLI is the final judge)", () => {
    expect(validateModelChoice(seed(), "claude-opus-9-9", "high")).toBeNull();
    expect(validateModelChoice(seed(), "opus[1m]", null)).toBeNull();
    expect(validateModelChoice(seed(), "rm -rf /", null)).toMatch(/doesn't look like a model/);
  });

  it("finds an entry by its alias or resolved id, and orders effort levels on the ladder", () => {
    expect(findModel(live(), "claude-opus-9")?.value).toBe("default");
    expect(findModel(live(), "sonnet")?.displayName).toBe("Sonnet 9");
    expect(knownEffortLevels(live())).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("maps a choice onto SDK options, omitting effort when unset", () => {
    expect(sdkModelOptions({ model: "opus", effort: null })).toEqual({ model: "opus" });
    expect(sdkModelOptions({ model: "opus", effort: "max" })).toEqual({ model: "opus", effort: "max" });
  });
});

describe("model catalog", () => {
  it("falls back to the alias seed before anything is fetched", async () => {
    const c = await getModelCatalog();
    expect(c.source).toBe("seed");
    expect(c.models.map((m) => m.value)).toEqual(["opus", "sonnet", "haiku"]);
    expect(catalogIsStale(c)).toBe(true);
  });

  it("fetches with the supervisor credential, caches it, and stays fresh", async () => {
    await designateSupervisor();
    const c = await refreshModelCatalog();
    expect(c.source).toBe("live");
    expect(c.error).toBeUndefined();
    expect((sdk.lastOptions?.env as Record<string, string>).ANTHROPIC_API_KEY).toBe("test-cred");
    expect((await getModelCatalog()).models).toHaveLength(LIVE_MODELS.length);
    expect(catalogIsStale(await getModelCatalog())).toBe(false);
  });

  it("adds the Models API's pinned versions after the CLI's rows, with their effort levels", async () => {
    await designateSupervisor();
    sdk.supportedModels = async () => LIVE_MODELS.filter((m) => m.value === m.resolvedModel ? false : true); // aliases only, like an OAuth credential
    api.models = API_MODELS;
    const c = await refreshModelCatalog();
    expect(c.models.map((m) => m.value)).toEqual(["default", "opus", "sonnet", "claude-opus-9", "claude-opus-4-6", "claude-haiku-4-5-20251001"]);
    expect(findModel(c, "claude-opus-4-6")).toMatchObject({ displayName: "Opus 4.6", supportedEffortLevels: ["low", "medium", "high", "max"], description: /Deprecated/ });
    expect(findModel(c, "claude-sonnet-3")).toBeUndefined(); // retired
    expect(validateModelChoice(c, "claude-haiku-4-5-20251001", "low")).toMatch(/doesn't support effort/);
    expect(api.lastOptions).toMatchObject({ apiKey: "test-cred" });
  });

  it("uses an OAuth credential as a bearer token with the oauth beta", async () => {
    await queries.createUser({ id: "usr_o", email: "o@x.io" });
    await queries.upsertUserCredential("usr_o", "claude_oauth_token", await new LocalAesCipher(KEY).encrypt("oauth-tok"));
    await queries.setAppSetting(SUPERVISOR_CRED_SETTING, "usr_o");
    await refreshModelCatalog();
    expect(api.lastOptions).toMatchObject({ apiKey: null, authToken: "oauth-tok", defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" } });
  });

  it("builds the catalog from whichever source answers", async () => {
    await designateSupervisor();
    sdk.supportedModels = async () => { throw new Error("cli down"); };
    api.models = API_MODELS;
    let c = await refreshModelCatalog();
    expect(c.source).toBe("live");
    expect(c.models.map((m) => m.value)).toContain("claude-opus-9");
    sdk.supportedModels = async () => LIVE_MODELS;
    api.fail = new Error("api down");
    c = await refreshModelCatalog();
    expect(c.models).toHaveLength(LIVE_MODELS.length);
  });

  it("merging keeps a CLI row but fills effort it lacks from the API", () => {
    const merged = mergeCatalogSources(
      [{ value: "claude-x", resolvedModel: "claude-x", displayName: "X", description: "" }],
      [{ value: "claude-x", resolvedModel: "claude-x", displayName: "X api", description: "", supportsEffort: true, supportedEffortLevels: ["low"] }],
    );
    expect(merged).toEqual([{ value: "claude-x", resolvedModel: "claude-x", displayName: "X", description: "", supportsEffort: true, supportedEffortLevels: ["low"] }]);
  });

  it("is stale once a day old or when the installed SDK version changes", () => {
    const dayOld = { ...live(), fetched_at: new Date(Date.now() - 25 * 3600_000).toISOString() };
    expect(catalogIsStale(live())).toBe(false);
    expect(catalogIsStale(dayOld)).toBe(true);
    expect(catalogIsStale({ ...live(), format: undefined })).toBe(true); // built before the Models API merge
    if (installedSdkVersion()) expect(catalogIsStale({ ...live(), sdk_version: "0.0.1" })).toBe(true);
  });

  it("keeps the previous catalog when a refresh fails", async () => {
    await designateSupervisor();
    await refreshModelCatalog();
    sdk.supportedModels = async () => { throw new Error("cli exploded"); };
    api.fail = new Error("api exploded");
    const c = await refreshModelCatalog();
    expect(c.source).toBe("live");
    expect(c.error).toMatch(/cli exploded.*api exploded/);
    expect((await getModelCatalog()).models).toHaveLength(LIVE_MODELS.length);
  });

  it("reports a missing credential instead of throwing", async () => {
    const c = await refreshModelCatalog();
    expect(c.source).toBe("seed");
    expect(c.error).toMatch(/no supervisor credential/);
  });
});

describe("role defaults", () => {
  it("built-ins are family aliases; the review agent inherits", async () => {
    const d = await getModelDefaults();
    expect(d.agent).toEqual({ model: "opus", effort: null });
    expect(d.supervisor.model).toBe("sonnet");
    expect(d.review_agent.model).toBeNull();
    expect(await resolveRole("review_agent", "claude-opus-4-6")).toEqual({ model: "claude-opus-4-6", effort: null });
    expect((await resolveRole("review_agent")).model).toBe("opus"); // nothing to inherit → agent default
  });

  it("layers built-in < DABOSS_MODEL_DEFAULTS < admin setting, ignoring junk", async () => {
    process.env.DABOSS_MODEL_DEFAULTS = JSON.stringify({ agent: { effort: "high" }, supervisor: { model: "haiku" }, bogus: { model: "x" } });
    let d = await getModelDefaults();
    expect(d.agent).toEqual({ model: "opus", effort: "high" });
    expect(d.supervisor.model).toBe("haiku");
    await queries.setAppSetting(DEFAULTS_SETTING, JSON.stringify({ agent: { model: "sonnet", effort: "max" } }));
    d = await getModelDefaults();
    expect(d.agent).toEqual({ model: "sonnet", effort: "max" });
    expect(d.supervisor.model).toBe("haiku"); // env layer still applies to roles the admin didn't set
  });

  it("survives a malformed env override", async () => {
    process.env.DABOSS_MODEL_DEFAULTS = "{not json";
    expect((await getModelDefaults()).agent.model).toBe("opus");
  });

  it("the review config carries the resolved model + effort", () => {
    const reviewed = { id: "ag_1", name: "x", model: "claude-opus-4-6", repo_url: "https://github.com/o/r", branch: "feat/x", adopted_ref: null, repo_ref: "main", prompt: "p" } as unknown as AgentRecord;
    expect(buildReviewConfig(reviewed, "ok").model).toBe("claude-opus-4-6");
    const cfg = buildReviewConfig(reviewed, "ok", "", { model: "sonnet", effort: "high" });
    expect(cfg.model).toBe("sonnet");
    expect(cfg.effort).toBe("high");
  });
});

describe("model API", () => {
  let app: express.Express;
  let seq = 0;
  async function login() {
    const a = request.agent(app);
    seq++;
    await a.post("/api/auth/register").send({ email: `m${seq}@t.co`, password: "password123" }).expect(201);
    return a;
  }

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use(session({ secret: "t", resave: false, saveUninitialized: false }));
    app.use(createRouter(new AgentManager(new EventEmitter())));
  });

  it("an agent created with no model gets the 'agent' role's model + effort", async () => {
    const admin = await login(); // first user = admin
    let res = await admin.post("/api/agents").send({ name: "a", prompt: "p", cwd: "/tmp" }).expect(201);
    expect(res.body.model).toBe("opus");
    expect(res.body.effort).toBeNull();

    await admin.put("/api/admin/model-defaults").send({ agent: { model: "sonnet", effort: "high" } }).expect(200);
    res = await admin.post("/api/agents").send({ name: "b", prompt: "p", cwd: "/tmp" }).expect(201);
    expect(res.body).toMatchObject({ model: "sonnet", effort: "high" });

    // An explicit model runs at its own default effort, not the role's.
    res = await admin.post("/api/agents").send({ name: "c", prompt: "p", cwd: "/tmp", model: "haiku" }).expect(201);
    expect(res.body).toMatchObject({ model: "haiku", effort: null });
  });

  it("rejects an effort the chosen model doesn't support", async () => {
    await designateSupervisor();
    await refreshModelCatalog();
    const admin = await login();
    const res = await admin.post("/api/agents").send({ name: "a", prompt: "p", cwd: "/tmp", model: "claude-opus-4-6", effort: "xhigh" }).expect(400);
    expect(res.body.error).toMatch(/Opus 4.6 supports effort/);
    await admin.post("/api/agents").send({ name: "b", prompt: "p", cwd: "/tmp", model: "claude-opus-4-6", effort: "max" }).expect(201);
  });

  it("serves the catalog without the CLI's 'default' row, plus defaults and roles", async () => {
    const user = await login();
    const res = await user.get("/api/models").expect(200);
    expect(res.body.source).toBe("seed");
    expect(res.body.models.map((m: { value: string }) => m.value)).not.toContain("default");
    expect(res.body.defaults.agent.model).toBe("opus");
    expect(res.body.roles.review_agent.inheritable).toBe(true);
  });

  it("templates prefill the 'template' role", async () => {
    const admin = await login();
    await admin.put("/api/admin/model-defaults").send({ template: { model: "haiku", effort: "low" } }).expect(200);
    const res = await admin.get("/api/templates").expect(200);
    expect(res.body.every((t: { model: string; effort: string }) => t.model === "haiku" && t.effort === "low")).toBe(true);
  });

  it("guards the admin endpoints and validates role choices", async () => {
    const admin = await login();
    const user = await login();
    await user.put("/api/admin/model-defaults").send({ agent: { model: "opus" } }).expect(403);
    await admin.put("/api/admin/model-defaults").send({ agent: { model: "" } }).expect(400); // not inheritable
    await admin.put("/api/admin/model-defaults").send({ review_agent: { model: "" } }).expect(200); // inherit is fine
    await admin.put("/api/admin/model-defaults").send({ supervisor: { model: "sonnet", effort: "warp" } }).expect(400);
    const reset = await admin.delete("/api/admin/model-defaults").expect(200);
    expect(reset.body.defaults.agent.model).toBe("opus");
  });
});
