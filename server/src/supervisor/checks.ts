import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { resolveSupervisorCredentialEnv } from "./credential.js";
import { withClaudeLock } from "../utils/claude-lock.js";
import * as queries from "../db/queries.js";
import { sendNotification } from "../notifications/ntfy.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

interface Finding {
  agentId?: string; // omitted for fleet-level findings (e.g. lease reclamation)
  type: string;
  message: string;
}

interface Action {
  agentId: string;
  type: string;
  detail: string;
}

// Cooldown tracking: prevent supervisor from re-acting on the same agent too quickly
// The supervisor makes consequential judgments — deciding to block/steer an
// agent's work, or answering a permission question on the human's behalf. That's
// deep reasoning about intent + correctness, not a cheap triage, so it runs on a
// capable model (Sonnet), with a budget high enough that a long transcript won't
// truncate the call to an empty result.
const SUPERVISOR_MODEL = "claude-sonnet-5";
const SUPERVISOR_MAX_USD = 0.2;

const lastSupervisorAction = new Map<string, number>(); // agentId -> timestamp
const supervisorActionCount = new Map<string, number>(); // agentId -> count since last reset
const COOLDOWN_MS = 15 * 60 * 1000; // 15 min between supervisor actions on same agent
const MAX_ACTIONS_PER_AGENT = 3; // max supervisor interventions before requiring human

function canActOnAgent(agentId: string): boolean {
  const lastAction = lastSupervisorAction.get(agentId);
  if (lastAction && Date.now() - lastAction < COOLDOWN_MS) return false;

  const count = supervisorActionCount.get(agentId) || 0;
  if (count >= MAX_ACTIONS_PER_AGENT) return false;

  return true;
}

function recordAction(agentId: string): void {
  lastSupervisorAction.set(agentId, Date.now());
  supervisorActionCount.set(agentId, (supervisorActionCount.get(agentId) || 0) + 1);
}

/** Reset action count for an agent (call when user manually interacts). */
export function resetAgentCooldown(agentId: string): void {
  lastSupervisorAction.delete(agentId);
  supervisorActionCount.delete(agentId);
}

/** Minutes elapsed since a DB timestamp. The pg type parser (db/index.ts)
 *  returns ISO strings that already end in "Z"; pg-mem in tests hands back Date
 *  objects; only a zone-less string (the old SQLite format) needs "Z" appended.
 *  Appending unconditionally produced "…ZZ" → Invalid Date → NaN, which made
 *  every threshold comparison below silently false. */
export function minutesSince(ts: string | Date, now: number): number {
  const d =
    ts instanceof Date
      ? ts
      : new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(ts) ? ts : ts + "Z");
  return (now - d.getTime()) / 60_000;
}

/** What runChecks needs from its host. The boss supplies all of it; the
 *  standalone orchestrator pod supplies only the pod-translatable actions
 *  (getAgentsToPause/pauseAgent) and omits the Claude-powered ones — those paths
 *  degrade to "notify a human" when the dep is absent. */
export interface SupervisorDeps {
  getAgentsToPause(): Promise<string[]>;
  pauseAgent(agentId: string): Promise<void>;
  resolvePermission?(id: number, decision: "approved" | "denied", answer?: string): Promise<boolean>;
  sendInput?(agentId: string, message: string): Promise<void>;
  /** Stop a misbehaving agent (off-track / repeatedly ignoring advisories). */
  blockAgent?(agentId: string, reason: string): Promise<void>;
  /** Redirect a RUNNING agent mid-turn without killing it (interrupt + new instruction). */
  steerAgent?(agentId: string, message: string): Promise<void>;
  /** Queue the repo's test gate on an agent's branch — the boss validating a change
   *  it judges ready. Auto-test on completion is OFF; the supervisor is one of the
   *  things (with the agent's run_checks + the human buttons) that can trigger it. */
  queueTestCycle?(agentId: string): Promise<boolean>;
}

/** The boss validates a change it judged done: queue the repo's test gate on the
 *  agent's branch (best-effort — no-op if the dep is absent or there's no PR/branch). */
async function queueTestsIfReady(agentId: string, deps: SupervisorDeps, actions: Action[]): Promise<void> {
  if (!deps.queueTestCycle) return;
  const started = await deps.queueTestCycle(agentId).catch(() => false);
  if (started) actions.push({ agentId, type: "supervisor_test", detail: "Supervisor queued a test cycle (validating the finished change)." });
}

export async function runChecks(
  deps: SupervisorDeps
): Promise<{ findings: Finding[]; actions: Action[] }> {
  const findings: Finding[] = [];
  const actions: Action[] = [];
  const now = Date.now();

  // Resolve the supervisor's Claude credential ONCE per cycle as a per-call env
  // (no global process.env mutation → no race with concurrent reviews). All Claude
  // evals below gate on credEnv.ok and pass credEnv.env to the SDK.
  const credEnv = await resolveSupervisorCredentialEnv();

  // ── Dead/hung pod detection (sidecar heartbeat) ───────
  // A running agent whose sidecar stopped beating is a hung or crashed pod — the
  // event-based "stuck" check below can't see this (a dead pod emits nothing).
  const hbCutoff = new Date(now - config.sidecarHeartbeatSeconds * 4 * 1000).toISOString();

  // Free the territory of dead holders: reclaim leases whose heartbeat went stale.
  const reclaimed = await queries.reclaimStaleLeases(hbCutoff);
  if (reclaimed.length) {
    findings.push({ type: "leases_reclaimed", message: `Reclaimed ${reclaimed.length} lease(s) from dead/stale holders` });
  }

  // Overlap watch: in advisory mode nobody is blocked, so the supervisor watches
  // how much agents are stepping on each other and escalates deep overlap — the
  // "whoa, we shouldn't both be in here" signal — before it becomes a merge mess.
  const overlap = computeLeaseOverlap(await queries.getActiveLeases());
  if (overlap.contested > 0) {
    findings.push({
      type: "lease_overlap",
      message: `${overlap.contested} function(s) contested by multiple agents; deepest ${overlap.deepest?.symbols.length ?? 0} between ${overlap.deepest?.a} & ${overlap.deepest?.b}`,
    });
    if (overlap.deepest && overlap.deepest.symbols.length >= config.leaseOverlapAlertThreshold) {
      const d = overlap.deepest;
      await sendNotification(
        "⚠️ Agents deeply overlapping",
        `Agents ${d.a} and ${d.b} are both changing ${d.symbols.length} of the same functions (${d.symbols.slice(0, 5).join(", ")}${d.symbols.length > 5 ? "…" : ""}). High merge-conflict risk — consider pausing one or serializing their work.`,
        "high"
      );
    }
  }

  // Block agents that keep breaking advisories (editing frozen code / forking
  // frozen symbols). Deterministic backstop at the hard threshold.
  if (deps.blockAgent) {
    for (const agent of await queries.getAgentsOverStrikeThreshold(config.advisoryBlockThreshold)) {
      const reason = `Blocked after ${agent.advisory_strikes} advisory violations (editing frozen code / forking frozen symbols despite warnings).`;
      await deps.blockAgent(agent.id, reason);
      findings.push({ agentId: agent.id, type: "blocked", message: reason });
      await sendNotification(`Agent "${agent.name}" blocked`, `${reason} Review before resuming.`, "high");
    }
  }

  // Claude judgment on running agents already showing a violation — catch one
  // that's "off in left field" before it hits the hard threshold. Cost-gated to
  // suspicious agents (>=1 strike); those blocked above are now paused, not running.
  if (deps.blockAgent && credEnv.ok) {
    const suspicious = (await queries.getAgentsByState("running")).filter((a) => a.advisory_strikes >= 1);
    for (const agent of suspicious) {
      if (!canActOnAgent(agent.id)) continue;
      try {
        const decision = await evaluateAgent(
          agent.id,
          agent.name,
          agent.prompt,
          agent.supervisor_instructions || "(none — judge against the original task and whether the agent is on-track)",
          credEnv.env
        );
        recordAction(agent.id);
        if (decision.action === "continue" && deps.steerAgent) {
          // Salvageable — redirect it mid-turn instead of killing the work.
          await deps.steerAgent(agent.id, decision.message);
          actions.push({ agentId: agent.id, type: "supervisor_steer", detail: `Redirected: ${decision.message.substring(0, 100)}` });
        } else if (decision.action === "block") {
          await deps.blockAgent(agent.id, `Supervisor stopped agent: ${decision.message}`);
          findings.push({ agentId: agent.id, type: "blocked", message: decision.message });
          await sendNotification(`Agent "${agent.name}" blocked by supervisor`, decision.message, "high");
        } else if (decision.action === "notify") {
          findings.push({ agentId: agent.id, type: "needs_attention", message: decision.message });
          await sendNotification(`Agent "${agent.name}" needs attention`, decision.message, "default");
        }
      } catch (err) {
        logger.error({ agentId: agent.id, err }, "Supervisor running-review failed");
      }
    }
  }

  for (const agent of await queries.getStaleHeartbeatAgents(hbCutoff)) {
    findings.push({
      agentId: agent.id,
      type: "pod_unhealthy",
      message: `No sidecar heartbeat for >${config.sidecarHeartbeatSeconds * 4}s — pod likely hung or dead`,
    });
    await sendNotification(
      `Agent "${agent.name}" pod unhealthy`,
      `Sidecar stopped heartbeating — the pod is likely hung or crashed. Task: ${agent.prompt.substring(0, 100)}`,
      "high"
    );
  }

  // ── Check stuck agents ────────────────────────────────
  const running = await queries.getAgentsByState("running");
  for (const agent of running) {
    const lastEvent = await queries.getLatestEventTime(agent.id);
    if (lastEvent) {
      const minutes = minutesSince(lastEvent, now);

      if (minutes > config.stuckThresholdMinutes) {
        findings.push({
          agentId: agent.id,
          type: "stuck",
          message: `No activity for ${Math.round(minutes)} minutes`,
        });

        await sendNotification(
          `Agent "${agent.name}" may be stuck`,
          `No activity for ${Math.round(minutes)} minutes. Task: ${agent.prompt.substring(0, 100)}`,
          "high"
        );
      }
    }
  }

  // ── Check stale permission requests ───────────────────
  // The requesting agent cannot approve its own tool calls — that's the point of
  // escalation. After 5 min with no human response, a SECOND agent (the
  // supervisor, on its own credential) judges the request against the original
  // task and supervisor_instructions. This covers ALL escalated tools (Bash,
  // risky edits, MCP…), not just the interactive ones. Opt-in per agent via
  // supervisor_instructions; without them (or without a credential / a
  // resolvePermission dep) requests fall through to notify/timeout findings.
  const pending = await queries.getPendingPermissions();
  for (const perm of pending) {
    const minutes = minutesSince(perm.created_at, now);
    if (minutes <= 5) continue;

    const interactive = perm.tool_name === "AskUserQuestion" || perm.tool_name === "ExitPlanMode";
    const agent = await queries.getAgent(perm.agent_id);

    if (agent?.supervisor_instructions && deps.resolvePermission && credEnv.ok) {
      // Deliberately NOT gated on canActOnAgent: resolving a permission is
      // unblocking, not intervening — the 15-min cooldown / lifetime action cap
      // would strand an agent that legitimately needs several approvals in a
      // session. The worker blocks on its request, so there is at most one
      // pending per agent; a deny→re-ask loop is bounded by the 5-min staleness
      // window per round.
      try {
        const decision = await evaluatePermission(
          perm.agent_id,
          agent.name,
          agent.prompt,
          agent.supervisor_instructions,
          perm.tool_name,
          perm.tool_input,
          credEnv.env
        );

        await deps.resolvePermission(perm.id, decision.decision, decision.answer);
        actions.push({
          agentId: perm.agent_id,
          type: "supervisor_permission",
          detail: `Supervisor ${decision.decision} ${perm.tool_name}: ${(decision.answer || "").substring(0, 100)}`,
        });
        logger.info(
          { agentId: perm.agent_id, tool: perm.tool_name, decision: decision.decision },
          "Supervisor resolved permission"
        );
        continue;
      } catch (err) {
        logger.error({ agentId: perm.agent_id, err }, "Supervisor permission evaluation failed");
      }
    }

    // Couldn't (or wasn't allowed to) auto-resolve. Interactive tools are a
    // conversation the agent can't progress without — flag those loudly;
    // everything else gets the timeout finding once it's truly overdue.
    if (interactive) {
      findings.push({
        agentId: perm.agent_id,
        type: "permission_needs_attention",
        message: `${perm.tool_name} waiting for response for ${Math.round(minutes)} min`,
      });
      await sendNotification(
        `Agent "${agent?.name || perm.agent_id}" needs your input`,
        `${perm.tool_name} has been waiting ${Math.round(minutes)} minutes`,
        "high"
      );
      continue;
    }

    if (minutes > config.permissionTimeoutMinutes) {
      findings.push({
        agentId: perm.agent_id,
        type: "permission_timeout",
        message: `Permission for ${perm.tool_name} pending ${Math.round(minutes)} min`,
      });
    }
  }

  // ── Check budget enforcement ──────────────────────────
  const toPause = await deps.getAgentsToPause();
  for (const agentId of toPause) {
    const agent = await queries.getAgent(agentId);
    if (!agent) continue;

    try {
      await deps.pauseAgent(agentId);
      actions.push({
        agentId,
        type: "budget_pause",
        detail: `Paused ${agent.priority} priority agent due to budget`,
      });

      await sendNotification(
        `Agent "${agent.name}" paused (budget)`,
        `${agent.priority} priority agent paused due to daily budget threshold`,
        "high"
      );
    } catch (err) {
      logger.error({ agentId, err }, "Failed to pause agent for budget");
    }
  }

  // ── Check completed agents with supervisor instructions ─
  const completed = await queries.getAgentsByState("completed");
  for (const agent of completed) {
    if (!agent.supervisor_instructions) continue;
    if (!canActOnAgent(agent.id)) continue;
    if (!deps.sendInput) continue; // continuation needs a resume path
    if (!credEnv.ok) continue; // no key → skip Claude eval, don't throw

    try {
      const decision = await evaluateAgent(agent.id, agent.name, agent.prompt, agent.supervisor_instructions, credEnv.env);

      if (decision.action === "continue") {
        // Send input to continue the agent
        await deps.sendInput(agent.id, decision.message);
        recordAction(agent.id);
        actions.push({
          agentId: agent.id,
          type: "supervisor_continue",
          detail: `Supervisor continued agent: ${decision.message.substring(0, 100)}`,
        });
        logger.info({ agentId: agent.id }, "Supervisor continued agent");
      } else if (decision.action === "notify") {
        recordAction(agent.id);
        await sendNotification(
          `Agent "${agent.name}" needs attention`,
          decision.message,
          "default"
        );
        findings.push({
          agentId: agent.id,
          type: "needs_attention",
          message: decision.message,
        });
      }
      // "done" = no action needed, but still record so we don't re-evaluate
      recordAction(agent.id);
    } catch (err) {
      logger.error({ agentId: agent.id, err }, "Supervisor evaluation failed");
    }
  }

  // ── Check idle waiting_input agents ───────────────────
  const waiting = await queries.getAgentsByState("waiting_input");
  for (const agent of waiting) {
    if (!canActOnAgent(agent.id)) continue;

    const lastEvent = await queries.getLatestEventTime(agent.id);
    if (!lastEvent) continue;

    const minutes = minutesSince(lastEvent, now);

    // If agent has supervisor instructions and has been idle > 2 min, evaluate —
    // but only when a Claude credential is actually loaded (else the SDK call
    // would just throw; fall through to the idle-warning path instead).
    if (agent.supervisor_instructions && minutes > 2 && deps.sendInput && credEnv.ok) {
      try {
        const decision = await evaluateAgent(agent.id, agent.name, agent.prompt, agent.supervisor_instructions, credEnv.env);
        if (decision.action === "continue") {
          await deps.sendInput(agent.id, decision.message);
          recordAction(agent.id);
          actions.push({
            agentId: agent.id,
            type: "supervisor_input",
            detail: `Supervisor provided input: ${decision.message.substring(0, 100)}`,
          });
          continue; // Skip idle warning
        } else if (decision.action === "done") {
          // Mark agent as completed
          await queries.updateAgentState(agent.id, "completed", {
            completed_at: new Date().toISOString(),
          });
          recordAction(agent.id);
          actions.push({
            agentId: agent.id,
            type: "supervisor_complete",
            detail: `Supervisor marked done: ${decision.message.substring(0, 100)}`,
          });
          // Boss judged it done → validate it (auto-test on completion is off).
          await queueTestsIfReady(agent.id, deps, actions);
          continue; // Skip idle warning
        } else if (decision.action === "notify") {
          recordAction(agent.id);
          findings.push({
            agentId: agent.id,
            type: "needs_attention",
            message: decision.message,
          });
          await sendNotification(
            `Agent "${agent.name}" needs attention`,
            decision.message,
            "default"
          );
          continue; // Skip generic idle warning
        }
      } catch (err) {
        logger.error({ agentId: agent.id, err }, "Supervisor input evaluation failed");
      }
    }

    // No supervisor instructions or evaluation didn't handle it — warn if idle too long
    if (minutes > 60) {
      findings.push({
        agentId: agent.id,
        type: "idle_waiting",
        message: `Waiting for input for ${Math.round(minutes)} minutes`,
      });

      await sendNotification(
        `Agent "${agent.name}" needs input`,
        `Waiting for ${Math.round(minutes)} minutes. Task: ${agent.prompt.substring(0, 100)}`,
        "default"
      );
    }
  }

  return { findings, actions };
}

interface SupervisorDecision {
  action: "continue" | "notify" | "done" | "block";
  message: string;
}

/** Contested symbols (held by >1 agent) + the agent pair with the deepest overlap. */
export function computeLeaseOverlap(
  active: Array<{ resource_ref: string; holder_agent_id: string }>
): { contested: number; deepest: { a: string; b: string; symbols: string[] } | null } {
  const byRef = new Map<string, Set<string>>();
  for (const l of active) {
    let s = byRef.get(l.resource_ref);
    if (!s) byRef.set(l.resource_ref, (s = new Set()));
    s.add(l.holder_agent_id);
  }
  const pairs = new Map<string, { a: string; b: string; symbols: string[] }>();
  let contested = 0;
  for (const [ref, holders] of byRef) {
    if (holders.size < 2) continue;
    contested++;
    const sym = ref.split("#").pop() || ref;
    const hs = [...holders].sort();
    for (let i = 0; i < hs.length; i++) {
      for (let j = i + 1; j < hs.length; j++) {
        const key = `${hs[i]}|${hs[j]}`;
        let e = pairs.get(key);
        if (!e) pairs.set(key, (e = { a: hs[i], b: hs[j], symbols: [] }));
        e.symbols.push(sym);
      }
    }
  }
  let deepest: { a: string; b: string; symbols: string[] } | null = null;
  for (const e of pairs.values()) if (!deepest || e.symbols.length > deepest.symbols.length) deepest = e;
  return { contested, deepest };
}

async function evaluateAgent(
  agentId: string,
  agentName: string,
  originalPrompt: string,
  instructions: string,
  env?: Record<string, string | undefined>
): Promise<SupervisorDecision> {
  // Get recent messages for context
  const recentEvents = await queries.getAgentEvents(agentId, 20);
  const recentMessages = recentEvents
    .filter((e) => e.type === "message")
    .reverse()
    .map((e) => {
      const data = JSON.parse(e.data);
      return `[${data.role}]: ${(data.content || "").substring(0, 300)}`;
    })
    .join("\n");

  const prompt = `You are a supervisor managing an AI coding agent. Evaluate whether this agent needs further instructions or is done.

AGENT: "${agentName}"
ORIGINAL TASK: ${originalPrompt.substring(0, 500)}

SUPERVISOR INSTRUCTIONS:
${instructions}

RECENT AGENT OUTPUT:
${recentMessages || "(no messages yet)"}

Based on the supervisor instructions, decide what to do:
- If the agent should continue with a new task or next step per the instructions, respond with: ACTION: continue
  Then on the next line: MESSAGE: <the instruction to send to the agent>
- If the agent needs human attention (ambiguous situation, error, etc), respond with: ACTION: notify
  Then on the next line: MESSAGE: <what to tell the human>
- If the agent has completed everything in the instructions, respond with: ACTION: done
  Then on the next line: MESSAGE: <summary>
- If the agent has gone off-track, is doing something harmful or clearly wrong, or is
  ignoring guardrails (e.g. forking frozen code to evade a lease), respond with: ACTION: block
  Then on the next line: MESSAGE: <why it must be stopped>

Respond with ONLY the ACTION and MESSAGE lines, nothing else.`;

  try {
    const result = await withClaudeLock(async () => {
      let r = "";
      for await (const msg of sdkQuery({
        prompt,
        options: {
          maxTurns: 1,
          maxBudgetUsd: SUPERVISOR_MAX_USD,
          model: SUPERVISOR_MODEL,
          env,
        },
      })) {
        if ("type" in msg && msg.type === "result" && "result" in msg) {
          r = (msg as { result: string }).result || "";
        }
      }
      return r;
    });

    // Parse the response
    const actionMatch = result.match(/ACTION:\s*(continue|notify|done|block)/i);
    const messageMatch = result.match(/MESSAGE:\s*(.+)/is);

    const action = (actionMatch?.[1]?.toLowerCase() || "notify") as SupervisorDecision["action"];
    const message = messageMatch?.[1]?.trim() || "Supervisor could not determine next action";

    logger.info({ agentId, action, message: message.substring(0, 100) }, "Supervisor evaluation result");

    return { action, message };
  } catch (err) {
    logger.error({ agentId, err }, "Supervisor Claude call failed");
    return { action: "notify", message: "Supervisor evaluation failed - needs human review" };
  }
}

interface PermissionDecision {
  decision: "approved" | "denied";
  answer: string;
}

async function evaluatePermission(
  agentId: string,
  agentName: string,
  originalPrompt: string,
  instructions: string,
  toolName: string,
  toolInputJson: string,
  env?: Record<string, string | undefined>
): Promise<PermissionDecision> {
  const recentEvents = await queries.getAgentEvents(agentId, 20);
  const recentMessages = recentEvents
    .filter((e) => e.type === "message")
    .reverse()
    .map((e) => {
      const data = JSON.parse(e.data);
      return `[${data.role}]: ${(data.content || "").substring(0, 500)}`;
    })
    .join("\n");

  let toolContext = "";
  try {
    const parsed = JSON.parse(toolInputJson);
    if (toolName === "AskUserQuestion" && Array.isArray(parsed.questions)) {
      toolContext = parsed.questions.map((q: { question?: string; header?: string; options?: Array<{ label?: string; description?: string }> }) => {
        const opts = q.options?.map((o) => `  - ${o.label}${o.description ? ` (${o.description})` : ""}`).join("\n") || "";
        return `Q: ${q.header ? `[${q.header}] ` : ""}${q.question || ""}\n${opts}`;
      }).join("\n\n");
    } else if (toolName === "ExitPlanMode" && parsed.plan) {
      toolContext = `PLAN:\n${String(parsed.plan).substring(0, 2000)}`;
    } else if (toolName === "Bash" && parsed.command) {
      toolContext = `COMMAND:\n${String(parsed.command).substring(0, 1500)}${parsed.description ? `\nSTATED PURPOSE: ${parsed.description}` : ""}`;
    } else {
      toolContext = `INPUT:\n${JSON.stringify(parsed, null, 2).substring(0, 1500)}`;
    }
  } catch {
    toolContext = toolInputJson.substring(0, 1000);
  }

  const prompt = toolName === "ExitPlanMode"
    ? `You are a supervisor managing an AI coding agent. The agent has proposed a plan and is waiting for approval.

AGENT: "${agentName}"
ORIGINAL TASK: ${originalPrompt.substring(0, 500)}

SUPERVISOR INSTRUCTIONS:
${instructions}

RECENT AGENT OUTPUT:
${recentMessages || "(no messages)"}

${toolContext}

Evaluate whether this plan aligns with the original task and supervisor instructions.
- If the plan is reasonable and matches the task requirements, respond with: DECISION: approved
  Then on the next line: ANSWER: <any feedback or notes for the agent>
- If the plan is wrong, off-track, or missing key requirements, respond with: DECISION: denied
  Then on the next line: ANSWER: <specific feedback on what to change>

Respond with ONLY the DECISION and ANSWER lines.`
    : toolName === "AskUserQuestion"
    ? `You are a supervisor managing an AI coding agent. The agent has asked a question and is waiting for user input, but the user hasn't responded.

AGENT: "${agentName}"
ORIGINAL TASK: ${originalPrompt.substring(0, 500)}

SUPERVISOR INSTRUCTIONS:
${instructions}

RECENT AGENT OUTPUT:
${recentMessages || "(no messages)"}

QUESTION:
${toolContext}

Based on the original task and supervisor instructions, provide the best answer to unblock the agent.
Respond with: DECISION: approved
Then on the next line: ANSWER: <your answer to the question, picking the most appropriate option or providing text>

If you genuinely cannot determine the right answer, respond with: DECISION: denied
Then on the next line: ANSWER: <explain why this needs human attention>

Respond with ONLY the DECISION and ANSWER lines.`
    : `You are a supervisor managing an AI coding agent. The agent wants to use a tool that requires approval, and no human has responded. The agent cannot approve its own tool calls — you decide on the human's behalf.

AGENT: "${agentName}"
ORIGINAL TASK: ${originalPrompt.substring(0, 500)}

SUPERVISOR INSTRUCTIONS:
${instructions}

RECENT AGENT OUTPUT:
${recentMessages || "(no messages)"}

REQUESTED TOOL: ${toolName}
${toolContext}

Approve only if the action clearly serves the original task and the supervisor instructions.
DENY if it is destructive or irreversible beyond the task's evident scope (deleting data,
force-pushing, wiping directories, dropping tables), touches credentials or secrets,
targets systems unrelated to the task, or you cannot tell what it actually does.
When in doubt, deny — a denied agent adapts; a bad approval can't be taken back.

- To approve, respond with: DECISION: approved
  Then on the next line: ANSWER: <optional note for the agent>
- To deny, respond with: DECISION: denied
  Then on the next line: ANSWER: <why, and what the agent should do instead>

Respond with ONLY the DECISION and ANSWER lines.`;

  try {
    const result = await withClaudeLock(async () => {
      let r = "";
      for await (const msg of sdkQuery({
        prompt,
        options: {
          maxTurns: 1,
          maxBudgetUsd: SUPERVISOR_MAX_USD,
          model: SUPERVISOR_MODEL,
          env,
        },
      })) {
        if ("type" in msg && msg.type === "result" && "result" in msg) {
          r = (msg as { result: string }).result || "";
        }
      }
      return r;
    });

    const decisionMatch = result.match(/DECISION:\s*(approved|denied)/i);
    const answerMatch = result.match(/ANSWER:\s*(.+)/is);

    const decision = (decisionMatch?.[1]?.toLowerCase() === "approved" ? "approved" : "denied") as PermissionDecision["decision"];
    const answer = answerMatch?.[1]?.trim() || "Supervisor auto-resolved";

    logger.info({ agentId, toolName, decision, answer: answer.substring(0, 100) }, "Supervisor permission evaluation");

    return { decision, answer };
  } catch (err) {
    logger.error({ agentId, err }, "Supervisor permission evaluation failed");
    return { decision: "denied", answer: "Supervisor evaluation failed — needs human review" };
  }
}
