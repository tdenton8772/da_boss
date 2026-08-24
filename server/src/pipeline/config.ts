/**
 * .daboss/pipeline.yaml — the domain-neutral automation contract. A repo declares
 * named PHASES; each is just a command plus what to inject and how to gate it.
 * da_boss knows nothing about terraform/ansible/mix/gcloud — those are strings.
 *
 * The runner contract (env in, exit + artifact out) is the universal CI/Unix one:
 *  - inputs:  `requires` (named vault secrets) + `params` are injected as ENV.
 *  - outputs: exit code = verdict; stdout streamed; $DABOSS_ARTIFACT file (or
 *             stdout) = the human-review artifact (a plan, a diff, --check output).
 */
import { parse as parseYaml } from "yaml";

/** A backing service the phase needs (e.g. a test database) — runs alongside the
 *  task as a native sidecar on the same localhost. Domain-neutral: any image. */
/** How to build a toolchain image from a Dockerfile in the repo, if it isn't in the
 *  registry yet. Keeps image DEFINITIONS in the repo (neutral) and self-bootstraps:
 *  da_boss builds `image` from `<context>/Dockerfile` (kaniko) when it's missing, and
 *  reuses it when it's present — `image`'s tag is the cache key. */
export interface ImageBuild {
  context: string; // Dockerfile context dir in the repo (e.g. "images/elixir-test")
  dockerfile?: string; // path relative to context (default "Dockerfile")
}

export interface PipelineService {
  image: string;
  build?: ImageBuild; // build `image` from the repo if it's missing (YAML: string context or { context, dockerfile })
  name?: string; // container name (default svc-N)
  port?: number; // if set, the task waits for localhost:<port> before running
  env?: Record<string, string>;
}

export interface PipelinePhase {
  command: string;
  image?: string; // toolchain image to run in (e.g. google/cloud-sdk); default: da_boss
  build?: ImageBuild; // build `image` from the repo if it's missing (YAML: string context or { context, dockerfile })
  requires?: string[]; // named secrets → injected as env vars
  params?: Record<string, string>; // static env params
  gate?: "human" | "auto"; // "human" → the run waits for an approve click
  only_ref?: string; // guardrail: phase may only run on this ref (e.g. deploy → main)
  adapter?: string; // optional richer handling (e.g. "terraform"); default generic
  lease?: { kind: string; ref: string }; // optional concurrency lease (e.g. tf_state)
  services?: PipelineService[]; // backing services (e.g. postgres for mix test)
  // k8s ServiceAccount the phase's pod runs as — the identity seam. A deploy phase
  // names a Workload-Identity-bound KSA so it can auth to GCP; default phases use
  // the namespace default. da_boss never bakes in an identity — the repo config does.
  service_account?: string;
  // When true, approving this (gate:human) phase dispatches a MANAGED AGENT to run
  // the command instead of a dumb pod — so the run streams live and the agent can
  // interpret results + roll back on failure. da_boss supplies its own agent-capable
  // image (config: deployAgentImage); the phase keeps supplying command + identity.
  agent?: boolean;
  // Boss-triggered recurrence: "nightly" runs the phase on main roughly once every
  // 24h with no human trigger (e.g. a data-snapshot or drift-check phase). The
  // phase failing IS the alert — no extra config.
  schedule?: "nightly";
  // Inject the named phase's LATEST PASSED artifact as a file; the command reads
  // it at $DABOSS_SEED. How to consume it (psql restore, diff input, …) is the
  // command's business — da_boss just delivers bytes. E.g. a test phase declares
  // artifact_from: snapshot to seed its service DB with last night's sample.
  artifact_from?: string;
  // Deliver this phase's latest PASSED artifact into every AGENT pod for the
  // repo as the $DABOSS_SEED file — so agents work against real data (e.g. a
  // nightly DB snapshot) instead of improvising blank databases. At most one
  // phase per pipeline should set this; the first declaring phase wins.
  expose_to_agents?: boolean;
}

/** Repo-declared agent policy — the repo's side of the permission contract. */
export interface AgentPolicy {
  // Tool names agents may use on this repo WITHOUT a permission round-trip
  // (e.g. the repo's own read-only MCP tools like a knowledge-base search).
  // Repo-declared trust: whoever can merge to the repo already controls its
  // pipeline commands and .mcp.json servers, so they may also mark tools safe.
  // NEVER applied to review agents (same gate as .mcp.json loading).
  auto_approve_tools?: string[];
}

export interface Pipeline {
  version?: number;
  phases: Record<string, PipelinePhase>;
  agents?: AgentPolicy;
}

export const PIPELINE_PATH = ".daboss/pipeline.yaml";

/** A phase is a PR-gating test phase if it's named `test` or `test-<suite>`
 *  (e.g. test-elixir, test-web). All of a repo's test phases must pass to gate a
 *  PR / land — so a repo can split suites by toolchain into separate phases. */
export function isTestPhase(name: string): boolean {
  return name === "test" || name.startsWith("test-");
}

function asStringArray(v: unknown, where: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new Error(`${where} must be a list of strings`);
  }
  return v as string[];
}

function asStringMap(v: unknown, where: string): Record<string, string> | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${where} must be a map`);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = String(val);
  return out;
}

/** Normalize a `build:` field — accepts a string (the Dockerfile context) or
 *  `{ context, dockerfile }` — into an ImageBuild. */
function parseBuild(v: unknown, where: string): ImageBuild | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "string") {
    if (!v.trim()) throw new Error(`${where}.build (context) must be non-empty`);
    return { context: v };
  }
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    const b = v as Record<string, unknown>;
    if (typeof b.context !== "string" || !b.context.trim()) throw new Error(`${where}.build needs a 'context'`);
    return { context: b.context, dockerfile: typeof b.dockerfile === "string" ? b.dockerfile : undefined };
  }
  throw new Error(`${where}.build must be a string (context) or { context, dockerfile }`);
}

/** Parse + validate a pipeline definition. Throws with a clear message on bad input. */
export function parsePipeline(yamlText: string): Pipeline {
  const doc = parseYaml(yamlText) as unknown;
  if (typeof doc !== "object" || doc === null) throw new Error("pipeline must be a mapping");
  const d = doc as { version?: unknown; phases?: unknown; agents?: unknown };
  if (typeof d.phases !== "object" || d.phases === null || Array.isArray(d.phases)) {
    throw new Error("pipeline.phases must be a map of phase name → phase");
  }

  const phases: Record<string, PipelinePhase> = {};
  for (const [name, raw] of Object.entries(d.phases as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) throw new Error(`phase '${name}' must be a mapping`);
    const p = raw as Record<string, unknown>;
    if (typeof p.command !== "string" || !p.command.trim()) {
      throw new Error(`phase '${name}' needs a non-empty 'command'`);
    }
    if (p.gate !== undefined && p.gate !== "human" && p.gate !== "auto") {
      throw new Error(`phase '${name}'.gate must be 'human' or 'auto'`);
    }
    let lease: PipelinePhase["lease"];
    if (p.lease !== undefined) {
      const l = p.lease as Record<string, unknown>;
      if (typeof l?.kind !== "string" || typeof l?.ref !== "string") {
        throw new Error(`phase '${name}'.lease needs { kind, ref }`);
      }
      lease = { kind: l.kind, ref: l.ref };
    }
    let services: PipelineService[] | undefined;
    if (p.services !== undefined) {
      if (!Array.isArray(p.services)) throw new Error(`phase '${name}'.services must be a list`);
      services = p.services.map((s, i) => {
        const sv = s as Record<string, unknown>;
        if (typeof sv?.image !== "string" || !sv.image.trim()) throw new Error(`phase '${name}'.services[${i}] needs an 'image'`);
        return {
          image: sv.image,
          build: parseBuild(sv.build, `phase '${name}'.services[${i}]`),
          name: typeof sv.name === "string" ? sv.name : undefined,
          port: typeof sv.port === "number" ? sv.port : undefined,
          env: asStringMap(sv.env, `phase '${name}'.services[${i}].env`),
        };
      });
    }
    phases[name] = {
      command: p.command,
      image: typeof p.image === "string" ? p.image : undefined,
      build: parseBuild(p.build, `phase '${name}'`),
      requires: asStringArray(p.requires, `phase '${name}'.requires`),
      params: asStringMap(p.params, `phase '${name}'.params`),
      gate: (p.gate as "human" | "auto") ?? "auto",
      only_ref: typeof p.only_ref === "string" ? p.only_ref : undefined,
      adapter: typeof p.adapter === "string" ? p.adapter : undefined,
      lease,
      services,
      service_account: typeof p.service_account === "string" ? p.service_account : undefined,
      agent: p.agent === true,
      schedule: p.schedule === undefined ? undefined : (() => {
        if (p.schedule !== "nightly") throw new Error(`phase '${name}'.schedule must be "nightly"`);
        return "nightly" as const;
      })(),
      artifact_from: p.artifact_from === undefined ? undefined : (() => {
        if (typeof p.artifact_from !== "string" || !p.artifact_from.trim()) {
          throw new Error(`phase '${name}'.artifact_from must be a phase name`);
        }
        return p.artifact_from;
      })(),
      expose_to_agents: p.expose_to_agents === true,
    };
  }
  for (const [name, ph] of Object.entries(phases)) {
    if (ph.artifact_from && !phases[ph.artifact_from]) {
      throw new Error(`phase '${name}'.artifact_from names unknown phase '${ph.artifact_from}'`);
    }
  }
  if (!Object.keys(phases).length) throw new Error("pipeline has no phases");

  let agents: AgentPolicy | undefined;
  if (d.agents !== undefined) {
    if (typeof d.agents !== "object" || d.agents === null || Array.isArray(d.agents)) {
      throw new Error("pipeline.agents must be a mapping");
    }
    const a = d.agents as Record<string, unknown>;
    agents = { auto_approve_tools: asStringArray(a.auto_approve_tools, "agents.auto_approve_tools") };
  }

  return { version: typeof d.version === "number" ? d.version : undefined, phases, agents };
}
