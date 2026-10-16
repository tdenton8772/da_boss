/**
 * Models + reasoning effort — discovered, not hardcoded.
 *
 * The catalog merges two live sources, both read with the supervisor credential:
 *  - the Claude Code CLI the Agent SDK bundles (`supportedModels()`): the family
 *    aliases (`opus`, `sonnet`, …) with the concrete id each resolves to;
 *  - the Anthropic Models API (`GET /v1/models`): every pinned version the
 *    credential can use, with the effort levels each accepts. (For an OAuth
 *    credential the CLI lists only the aliases, so this is where versions come from.)
 * Cached in app_settings and refreshed daily or when the SDK version changes,
 * so a new model shows up on its own — no code edit.
 *
 * Which model + effort each part of da_boss uses is a ROLE default. The built-in
 * defaults name family aliases, so they follow new releases on their own; a
 * deployment overrides them via DABOSS_MODEL_DEFAULTS (JSON) and an admin via the
 * Settings UI (app_settings "model_defaults"), the same layering as size presets.
 */
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { query as sdkQuery, type EffortLevel, type ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import Anthropic from "@anthropic-ai/sdk";
import { withClaudeLock } from "./utils/claude-lock.js";
import { logger } from "./utils/logger.js";

// ── Effort ───────────────────────────────────────────────────────────────────

/** Fallback effort ladder, used only until a live catalog says what each model
 *  takes. `satisfies` keeps it honest against the SDK's own EffortLevel type. */
const FALLBACK_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly EffortLevel[];

export function normalizeEffort(effort: string | null | undefined): EffortLevel | null {
  const e = effort?.toLowerCase().trim();
  return e ? (e as EffortLevel) : null;
}

// ── Catalog ──────────────────────────────────────────────────────────────────

export type CatalogModel = Pick<ModelInfo, "value" | "resolvedModel" | "displayName" | "description" | "supportsEffort" | "supportedEffortLevels">;

export interface ModelCatalog {
  /** "live" = reported by the CLI for a real credential; "seed" = aliases only. */
  source: "live" | "seed";
  models: CatalogModel[];
  fetched_at: string | null;
  /** SDK version that produced it — a different installed version forces a refetch. */
  sdk_version: string | null;
  /** Why the last refresh failed, if it did (the previous catalog is kept). */
  error?: string;
  /** How the catalog was built — bump CATALOG_FORMAT to refetch caches built the old way. */
  format?: number;
}

/** 2 = CLI aliases merged with the Models API's pinned versions. */
const CATALOG_FORMAT = 2;

const CATALOG_SETTING = "model_catalog";
const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CATALOG_FETCH_TIMEOUT_MS = 60_000;

/** Before any live fetch: the CLI's family aliases. These are stable names the
 *  CLI resolves to the newest model of each family — not version pins. */
const SEED_MODELS: CatalogModel[] = [
  { value: "opus", displayName: "Opus (latest)", description: "Newest Opus" },
  { value: "sonnet", displayName: "Sonnet (latest)", description: "Newest Sonnet" },
  { value: "haiku", displayName: "Haiku (latest)", description: "Newest Haiku" },
];

let sdkVersionCache: string | null | undefined;
/** The installed Agent SDK's version (its package.json isn't exported, so read it
 *  from beside the resolved entrypoint). Null when it can't be determined. */
export function installedSdkVersion(): string | null {
  if (sdkVersionCache !== undefined) return sdkVersionCache;
  try {
    const entry = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
    sdkVersionCache = (JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")) as { version?: string }).version ?? null;
  } catch {
    sdkVersionCache = null;
  }
  return sdkVersionCache;
}

function seedCatalog(error?: string): ModelCatalog {
  return { source: "seed", models: SEED_MODELS, fetched_at: null, sdk_version: null, ...(error ? { error } : {}) };
}

/** The current catalog: the cached live one if present, else the alias seed. */
export async function getModelCatalog(): Promise<ModelCatalog> {
  try {
    const { getAppSetting } = await import("./db/queries.js");
    const raw = await getAppSetting(CATALOG_SETTING);
    if (raw) {
      const parsed = JSON.parse(raw) as ModelCatalog;
      if (Array.isArray(parsed.models) && parsed.models.length) return parsed;
    }
  } catch { /* bad/absent cache → seed */ }
  return seedCatalog();
}

/** Picker-facing models: the CLI's "default" row is the credential's own default,
 *  which would only compete with da_boss's role defaults, so it's left out. */
export function selectableModels(catalog: ModelCatalog): CatalogModel[] {
  return catalog.models.filter((m) => m.value !== "default");
}

/** The catalog entry for a model, matched by its id or the alias that covers it. */
export function findModel(catalog: ModelCatalog, model: string): CatalogModel | undefined {
  return catalog.models.find((m) => m.value === model) ?? catalog.models.find((m) => m.resolvedModel === model);
}

/** Every effort level any catalog model accepts, in ladder order. */
export function knownEffortLevels(catalog: ModelCatalog): EffortLevel[] {
  const seen = new Set<string>();
  for (const m of catalog.models) for (const e of m.supportedEffortLevels ?? []) seen.add(e);
  if (!seen.size) return [...FALLBACK_EFFORT_LEVELS];
  const order: string[] = [...FALLBACK_EFFORT_LEVELS];
  return [...seen].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)) as EffortLevel[];
}

/** Ask the bundled CLI which models this credential can use. No prompt is ever
 *  sent — the catalog comes back during session setup — so it costs no tokens. */
async function fetchSupportedModels(env: Record<string, string | undefined>): Promise<ModelInfo[]> {
  const abortController = new AbortController();
  // A prompt stream that never yields: the session initializes, nothing is sent.
  const idle = (async function* () { await new Promise<never>(() => {}); })();
  const q = sdkQuery({ prompt: idle, options: { env, settingSources: [], cwd: tmpdir(), abortController } });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      q.supportedModels(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no catalog within ${CATALOG_FETCH_TIMEOUT_MS / 1000}s`)), CATALOG_FETCH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    try { q.close(); } catch { /* already gone */ }
    abortController.abort();
  }
}

/** Every model the credential can use, from the Models API: pinned ids with their
 *  effort levels. Retired models are dropped; deprecated ones are labelled. */
async function fetchApiModels(env: Record<string, string | undefined>): Promise<CatalogModel[]> {
  const client = env.ANTHROPIC_API_KEY
    ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: CATALOG_FETCH_TIMEOUT_MS })
    : new Anthropic({
        apiKey: null,
        authToken: env.CLAUDE_CODE_OAUTH_TOKEN,
        defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
        timeout: CATALOG_FETCH_TIMEOUT_MS,
      });
  const out: CatalogModel[] = [];
  for await (const m of client.models.list()) {
    if (m.lifecycle === "retired") continue;
    // Keys of the effort capability are its levels (plus the `supported` flag).
    const effort = (m.capabilities?.effort ?? {}) as unknown as Record<string, { supported?: boolean } | boolean | null>;
    const levels = Object.entries(effort)
      .filter(([, v]) => typeof v === "object" && v?.supported === true)
      .map(([k]) => k as EffortLevel);
    out.push({
      value: m.id,
      resolvedModel: m.id,
      displayName: m.display_name.replace(/^Claude\s+/, ""),
      description: m.lifecycle === "deprecated" ? "Deprecated — headed for retirement" : "",
      supportsEffort: levels.length > 0,
      supportedEffortLevels: levels,
    });
  }
  return out;
}

/** CLI rows first (aliases, then whatever pinned ids it lists), then the Models
 *  API's ids it didn't. A row both know takes the API's effort levels when the
 *  CLI gave none. */
export function mergeCatalogSources(cli: CatalogModel[], api: CatalogModel[]): CatalogModel[] {
  const byId = new Map(api.map((m) => [m.value, m]));
  const merged = cli.map((m) => {
    const a = byId.get(m.value);
    return a && !m.supportedEffortLevels?.length
      ? { ...m, supportsEffort: a.supportsEffort, supportedEffortLevels: a.supportedEffortLevels }
      : m;
  });
  const seen = new Set(cli.map((m) => m.value));
  return [...merged, ...api.filter((m) => !seen.has(m.value))];
}

/** Fetch a fresh catalog and cache it. On failure the previous catalog stays in
 *  place (with `error` recorded) — a flaky refresh never empties the picker. */
export async function refreshModelCatalog(): Promise<ModelCatalog> {
  const queries = await import("./db/queries.js");
  const previous = await getModelCatalog();
  const { resolveSupervisorCredentialEnv } = await import("./supervisor/credential.js");
  const cred = await resolveSupervisorCredentialEnv();
  const fail = async (error: string): Promise<ModelCatalog> => {
    const kept: ModelCatalog = { ...previous, error };
    if (previous.source === "live") await queries.setAppSetting(CATALOG_SETTING, JSON.stringify(kept));
    logger.warn({ error }, "Model catalog refresh failed — keeping the previous catalog");
    return kept;
  };
  if (!cred.ok || !cred.env) return fail(`no supervisor credential (${cred.reason ?? "unset"}) — set one in Settings to discover models`);
  try {
    // Either source may fail alone; the catalog needs only one of them.
    const [cliResult, apiResult] = await Promise.allSettled([
      withClaudeLock(() => fetchSupportedModels(cred.env!)),
      fetchApiModels(cred.env),
    ]);
    const cli: CatalogModel[] = cliResult.status === "fulfilled"
      ? cliResult.value.map((m) => ({
          value: m.value,
          resolvedModel: m.resolvedModel,
          displayName: m.displayName,
          description: m.description,
          supportsEffort: m.supportsEffort,
          supportedEffortLevels: m.supportedEffortLevels,
        }))
      : [];
    const api = apiResult.status === "fulfilled" ? apiResult.value : [];
    const reason = (r: PromiseSettledResult<unknown>) => (r.status === "rejected" ? (r.reason instanceof Error ? r.reason.message : String(r.reason)) : null);
    if (cliResult.status === "rejected") logger.warn({ error: reason(cliResult) }, "Model catalog: CLI source failed — using the Models API alone");
    if (apiResult.status === "rejected") logger.warn({ error: reason(apiResult) }, "Model catalog: Models API source failed — using the CLI alone");
    const models = mergeCatalogSources(cli, api);
    if (!models.length) {
      return fail(`no models from either source (CLI: ${reason(cliResult) ?? "none listed"}; Models API: ${reason(apiResult) ?? "none listed"})`);
    }
    const catalog: ModelCatalog = { source: "live", models, fetched_at: new Date().toISOString(), sdk_version: installedSdkVersion(), format: CATALOG_FORMAT };
    await queries.setAppSetting(CATALOG_SETTING, JSON.stringify(catalog));
    logger.info({ count: models.length, sdkVersion: catalog.sdk_version }, "Model catalog refreshed");
    return catalog;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** True when the cached catalog should be refetched: never fetched, built the old
 *  way, older than a day, or produced by a different SDK version than the one now
 *  installed. */
export function catalogIsStale(catalog: ModelCatalog, now = Date.now()): boolean {
  if (catalog.source !== "live" || !catalog.fetched_at) return true;
  if (catalog.format !== CATALOG_FORMAT) return true;
  if (now - Date.parse(catalog.fetched_at) > CATALOG_MAX_AGE_MS) return true;
  const installed = installedSdkVersion();
  return !!installed && catalog.sdk_version !== installed;
}

/** Boss startup: refresh now if stale, then check daily. Never throws. */
export function startModelCatalogRefresher(): NodeJS.Timeout {
  const tick = async () => {
    try {
      if (catalogIsStale(await getModelCatalog())) await refreshModelCatalog();
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Model catalog check failed");
    }
  };
  void tick();
  const timer = setInterval(tick, 60 * 60 * 1000); // hourly check; refetch only when stale
  timer.unref();
  return timer;
}

// ── Role defaults ────────────────────────────────────────────────────────────

/** A model + effort choice. `model: null` means "inherit" (see the role's note);
 *  `effort: null` means "the model's own default" — no effort is sent. */
export interface ModelChoice {
  model: string | null;
  effort: EffortLevel | null;
}

export const MODEL_ROLES = {
  agent:        { label: "New agents",          description: "Default for agents created without a model (UI, MCP, imports).", inheritable: false },
  template:     { label: "Templates",           description: "Model the built-in agent templates prefill.", inheritable: false },
  review_agent: { label: "Review agents",       description: "The agent that reviews a change. Inherit = same model as the agent under review.", inheritable: true },
  reviewer:     { label: "Review verdicts",     description: "Boss-side review + verdict classification calls.", inheritable: false },
  supervisor:   { label: "Supervisor",          description: "Steers idle/completed agents and answers permission requests.", inheritable: false },
  sizing:       { label: "Pod sizing",          description: "Classifies a task into an s/m/l/xl pod size.", inheritable: false },
  deploy:       { label: "Deploy agents",       description: "Managed deploy agents (pipeline phases with agent: true).", inheritable: false },
} as const;

export type ModelRole = keyof typeof MODEL_ROLES;
export const MODEL_ROLE_KEYS = Object.keys(MODEL_ROLES) as ModelRole[];

/** Built-in defaults — family aliases, so they track new releases by themselves. */
const BUILTIN_DEFAULTS: Record<ModelRole, ModelChoice> = {
  agent:        { model: "opus",   effort: null }, // code work
  template:     { model: "sonnet", effort: null },
  review_agent: { model: null,     effort: null }, // inherit the reviewed agent's model
  reviewer:     { model: "sonnet", effort: null },
  supervisor:   { model: "sonnet", effort: null },
  sizing:       { model: "sonnet", effort: null },
  deploy:       { model: "sonnet", effort: null },
};

export const DEFAULTS_SETTING = "model_defaults";

/** Merge a partial {role: {model?, effort?}} override over a base. Unknown roles
 *  and malformed entries are ignored, so a bad override can't break dispatch. */
function mergeDefaults(base: Record<ModelRole, ModelChoice>, raw: unknown): Record<ModelRole, ModelChoice> {
  if (!raw || typeof raw !== "object") return base;
  const out = { ...base };
  for (const role of MODEL_ROLE_KEYS) {
    const o = (raw as Record<string, unknown>)[role];
    if (!o || typeof o !== "object") continue;
    const { model, effort } = o as { model?: unknown; effort?: unknown };
    out[role] = {
      model: model === undefined ? base[role].model : typeof model === "string" && model.trim() ? model.trim() : null,
      effort: effort === undefined ? base[role].effort : typeof effort === "string" ? normalizeEffort(effort) : null,
    };
  }
  return out;
}

/** Built-ins with the DABOSS_MODEL_DEFAULTS env override applied (no admin layer). */
export function deploymentModelDefaults(): Record<ModelRole, ModelChoice> {
  const raw = process.env.DABOSS_MODEL_DEFAULTS;
  if (!raw) return BUILTIN_DEFAULTS;
  try {
    return mergeDefaults(BUILTIN_DEFAULTS, JSON.parse(raw));
  } catch {
    logger.warn("DABOSS_MODEL_DEFAULTS is not valid JSON — using built-in model defaults");
    return BUILTIN_DEFAULTS;
  }
}

/** Effective role defaults: built-in < env < admin-configured. */
export async function getModelDefaults(): Promise<Record<ModelRole, ModelChoice>> {
  const base = deploymentModelDefaults();
  try {
    const { getAppSetting } = await import("./db/queries.js");
    const raw = await getAppSetting(DEFAULTS_SETTING);
    if (raw) return mergeDefaults(base, JSON.parse(raw));
  } catch { /* bad/absent config → env/built-in */ }
  return base;
}

/** The model + effort a role runs with. An inheritable role with no model of its
 *  own falls back to `inheritFrom`, then to the new-agent default. */
export async function resolveRole(role: ModelRole, inheritFrom?: string | null): Promise<{ model: string; effort: EffortLevel | null }> {
  const defaults = await getModelDefaults();
  const choice = defaults[role];
  return {
    model: choice.model || inheritFrom || defaults.agent.model || BUILTIN_DEFAULTS.agent.model!,
    effort: choice.effort,
  };
}

/** The `model`/`effort` slice of SDK query options for a resolved choice. */
export function sdkModelOptions(choice: { model: string | null; effort: string | null }): { model?: string; effort?: EffortLevel } {
  return {
    ...(choice.model ? { model: choice.model } : {}),
    ...(choice.effort ? { effort: choice.effort as EffortLevel } : {}),
  };
}

// ── Validation ───────────────────────────────────────────────────────────────

/** Loose shape check for a model id/alias when no live catalog can vouch for it
 *  (ids like `claude-opus-5-5`, aliases like `opus`, `opus[1m]`). */
const MODEL_ID_SHAPE = /^[a-z][a-z0-9.\-_]*(\[[a-z0-9]+\])?$/i;

/**
 * Check a requested model + effort. Returns an error message, or null when OK.
 * A model the catalog doesn't list is still allowed when it's id-shaped: the
 * catalog comes from the SUPERVISOR's credential (which may list only aliases),
 * while agents run on their owner's — so it can't be the gate. The CLI rejects
 * truly unknown ids at run time. Effort is checked whenever the model is known.
 */
export function validateModelChoice(catalog: ModelCatalog, model: string | null | undefined, effort: string | null | undefined): string | null {
  const entry = model ? findModel(catalog, model) : undefined;
  if (model && !entry && !MODEL_ID_SHAPE.test(model)) {
    return `'${model}' doesn't look like a model id or alias. Known: ${selectableModels(catalog).map((m) => m.value).join(", ")}`;
  }
  if (effort) {
    const levels = knownEffortLevels(catalog);
    if (!levels.includes(effort as EffortLevel)) return `Invalid effort '${effort}'. Must be one of: ${levels.join(", ")}`;
    if (entry?.supportedEffortLevels?.length && !entry.supportedEffortLevels.includes(effort as EffortLevel)) {
      return `${entry.displayName} supports effort ${entry.supportedEffortLevels.join(", ")} — not '${effort}'`;
    }
    // A live entry with no effort info at all (e.g. Haiku 4.5) takes no effort.
    if (catalog.source === "live" && entry && !entry.supportsEffort && !entry.supportedEffortLevels?.length) {
      return `${entry.displayName} doesn't support effort levels`;
    }
  }
  return null;
}

/** Validate an agent-create request's model/effort against the live catalog. An
 *  effort with no model is checked against the 'agent' role default it'll run on. */
export async function checkAgentModelRequest(model: string | null | undefined, effort: string | null | undefined): Promise<string | null> {
  const catalog = await getModelCatalog();
  const target = model?.trim() || (effort ? (await resolveRole("agent")).model : null);
  return validateModelChoice(catalog, target, effort?.trim() || null);
}
