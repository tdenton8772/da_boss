# da_boss → Distributed Multi-Agent Development Platform

**Target:** multi-developer, multi-agent development against the app, with da_boss deployed into the same GKE cluster that runs the app-stg.

**Core constraint (design premise):** no human authors a PR by hand. All work is done by a person logging into da_boss, dispatching an agent, and the agent producing the change. This is not a limitation we tolerate — it is the assumption the whole design leans on. It gives the control plane *total, authoritative* knowledge of every in-flight change, with no exogenous edit source to defeat coordination. (See §6.2 / §13 — this is a *property of the current constraint*, not an assumption the code should hardcode.)

**Scope and boundary.** da_boss is a general-purpose, open-source governance framework for multi-agent software development. Its core (scheduler, lease manager, intent store, merge queue, lifecycle) is deliberately domain- **and** application-neutral. Application-specific systems built on top of this framework — including any proprietary autonomous-operations extensions — are **separate works and explicitly out of scope for this repository and this document.** This artifact describes only the OSS framework. Keeping it that way is not just architectural hygiene: this document may become public, so it must not describe or embed any mechanism that belongs to a separate, unpublished, or patent-pending system. The generality below is justified entirely on its own terms (optionality, the "two real instances before you abstract" rule), and names no downstream application.

---

## 1. The problem we are actually solving

Two problems are tangled in "multi-agent development," and they are not equally hard.

**Agent ↔ agent collision** is the hard one and it does not go away no matter what else we do. Many agents working in parallel produce many changes fast. They do not socially coordinate. Two agents touching interacting code produce conflicts — and the dangerous conflicts are *semantic*, not textual. Git already solves textual conflicts. The killer is: Agent A renames a function, Agent B adds a caller of the old name in a different file, git merges clean, the build breaks. Base drift (main advances while an agent works) and non-determinism (the same task run twice yields different diffs) compound it.

**Human ↔ agent collision** is the easy one, and our core constraint deletes it. Because every writer is an agent the boss dispatched, there is no human landing a commit outside the system. Leasing stops being advisory and becomes *sound*.

The design below spends its complexity budget on the agent-agent problem, because that is the part the no-human-PR constraint does *not* solve.

---

## 2. Core thesis: an AI-native PR discipline

Git's model is **optimistic concurrency on text**: everyone edits freely, a human resolves conflicts at merge time. That works when contributors are few, socially coordinated, and each conflict has a human who understands both sides. Agents break all three assumptions.

We replace it with three shifts.

### 2.1 Pessimistic on scope (leases)
Before an agent edits, the boss grants it a **lease** on a file/module set, and never grants overlapping leases. Collisions the boss can foresee never happen. Because all authorship is agent authorship, the lease is *mandatory and sound* — there is no side channel to bypass it.

### 2.2 Intent-native, not patch-native (the centerpiece)
A traditional PR is a frozen diff. An AI PR is better represented as a **reproducible intent plus a materialization**. We persist, per PR: the task spec, the plan, the intended file set, and a semantic-edit list (renamed X→Y, changed signature of Z, added function W).

The consequences:
- When the base moves, we do **not** rebase the patch. The authoring agent **re-runs its intent against the new base**. The diff is a *cache*, not the source of truth.
- Conflict resolution stops being a human job. The **authoring agent** fixes conflicts, because it is the only party that holds the intent. "Rebase PR #47 onto new main, preserve intent, make tests pass" is just another agent task.

This is the genuinely new part. Pieces exist elsewhere (merge queues, file locks in old VCS, preview envs). The intent-native representation and author-fixes-its-own-conflict rule are what make parallel agent output mergeable by construction.

### 2.3 Optimistic-but-verified on integration (merge queue)
Leasing cannot catch everything (cross-file semantic conflicts, drift). So we serialize *integration* through a queue that tests the **combined** result in an ephemeral the app env — not each PR alone. Combination fails → kick back to the authoring agent.

### 2.4 What the PR becomes
Coordination moves entirely up into the boss. The PR is no longer the negotiation venue. It demotes to an **audit + verification + revert record**: the place a human approves *intent*, inspects the diff on exception, and the unit you can revert. We keep it, and we build it on GitHub — reinventing review UI, revert, and history would be the least defensible code in the project.

---

## 3. Architecture

### 3.1 Placement in GKE
- da_boss **control plane** (boss): its own namespace in the the app-stg cluster. Own RBAC, resource quota, network policy.
- **Worker pods**: separate node pool, tainted, for agent execution. Agent workloads are bursty and occasionally hostile (OOM, runaway processes, arbitrary generated code) and must not share a node with the running staging app.
- **Never** the same namespace as the app-stg. Co-located cluster, isolated namespace.

### 3.2 Agents never develop against staging
Staging is a shared resource human devs depend on. Agents get **ephemeral the app environments** — one per branch/task, provisioned and destroyed. Staging stays stable.

### 3.3 The shape
```
person → da_boss UI → boss (control plane)
                        │
                        ├── scheduler: decomposes goal into disjoint tasks, grants leases
                        ├── lease manager (Postgres)
                        ├── intent store (Postgres)
                        ├── merge queue driver
                        ├── event bus (agents ↔ boss, NOT peer-to-peer)
                        ├── lifecycle gating
                        │
                        ▼ dispatches
              worker pod (per agent)
                        │  Claude Agent SDK query()
                        │  clean checkout + lease
                        │  ephemeral the app env  [SEAM 1]
                        │  Elixir/OTP + Python toolchain image  [SEAM 2]
                        ▼
              GitHub PR (materialization + review + revert surface)
                        │
                        ▼
              merge queue → deterministic CI/CD (test, deploy)  [SEAM 3: deploy confirm]
```

The three `[SEAM]` points are the only places the app-specific knowledge is allowed to live. See §9.

---

## 4. The core object and its lifecycle

The real unit of the system is not the agent and not the PR. It is **(intent + session + lease + proposed-delta)** bound together as one lifecycle-managed object. Born at dispatch, hibernating between actions, dying at the last recoverable gate.

> **Type discipline (matters for the schema, §5.4).** The core holds a *proposed-delta handle* and an *affected-scope* reference — not a `PR` and not a `file_path`. In this repo's first and only instance, a proposed-delta *materializes as* a GitHub PR and affected-scope *materializes as* a set of file paths, and the prose below uses "PR" freely because that is what it concretely is here. But the core object, the lease, and the intent store are stated over the abstract types so that no development-workflow concept (git, branch, PR, merge) is welded into the five core components. See §9 for why "development-neutral" is a stricter and more important boundary than "the app-neutral," and §5.4 for the one place this is expensive to get wrong later.

### 4.1 Lifecycle
1. **Dispatch.** Person interacts with an agent in da_boss. Scheduler assigns a task scoped to a lease. Intent (plan + intended files + semantic-edit list) is captured — reusing da_boss **plan mode**.
2. **Work.** Worker pod runs the SDK query against a clean checkout + ephemeral the app env, produces a PR.
3. **Hibernate.** Between actions the agent-as-process stops; the agent-as-resumable-session stays revivable. (da_boss already hibernates; the change is making revival work on a *different* pod — see §5.)
4. **Kickback → revive.** Any watcher signal (CI red, reviewer verdict, deploy failure, drift flag) revives the authoring agent with the signal as payload. It fixes and re-materializes.
5. **Terminate.** Session is destroyed at the **last gate that can still bounce work back to the agent.**

### 4.2 Lease vs session lifetime — decouple them
- **Lease** is about *write contention on code*. It releases at **merge**.
- **Session** is about *recoverability of intent*. It survives until **deploy confirmed**.

Binding both to the same instant was convenient but they answer different questions.

### 4.3 Where "destroy" lands
Destroy on the **last gate that can still hand work back to the authoring agent.** In a multi-region GKE rollout with real migrations, a post-merge deploy *can* fail in ways the authoring agent should fix (a migration behaving differently at real data volume, a lagging region, config that only exists in real GKE). So the boundary is **merged-and-deployed**, not merged.

Terminal on all of:
- deploy success, or
- deploy failure handed back to author and resolved, or
- a **TTL** that forces a human decision.

Deploy confirmation is an **event with a timeout**, never a state we wait on forever. A wedged rollout must not produce an immortal hibernated agent pinned to a stalled deploy.

---

## 5. Storage and state

### 5.1 The refactor forced by pods
Today workers are in-process SDK `query()` generators inside the single Express server; the SDK spawns `claude` CLI children tracked by PID; the session JSONL lives on local disk at `~/.claude/projects/...`; state is SQLite. Distributing this forces two changes:

**Session must leave local disk.** The reviving pod is a *different* pod with an empty disk. da_boss's current hibernation is *local* revival (same box re-reads its own disk). Distributed hibernation needs the state somewhere any pod can reach. This is the single biggest code change and it is the linchpin that makes destroy-and-revive real.

**SQLite → Postgres.** Non-negotiable. SQLite is single-writer embedded and corrupts on network storage; it cannot back a shared concurrent control plane. Postgres also backs the lease registry and the queue. Separate database from the app's — not a shared schema.

### 5.2 Session storage decision
Options considered:

| Option | Durable past pod death | Placement-free | Cost at rest | Boss stays authoritative | Notes |
|---|---|---|---|---|---|
| Parked pod (ephemeral disk) | No | No | High (parked pods) | Yes | Fine only if "destroy" means pause, not teardown. Evicted on node upgrade. |
| Non-ephemeral PV / PVC | Yes | **No (zone-pinned)** | Standing disk per idle agent | Yes | Idiomatic (StatefulSet pattern). Reference the **PVC name**, never the pod. Zonal RWO disk pins revival to one zone; multi-region → will hit it. Force-detach ~6 min on hard node death. |
| **GCS checkpoint by key** | Yes | **Yes** | **Near-zero** | Yes | On hibernate, checkpoint session blob to a bucket keyed by agent/PR id; revive pulls into any pod in any zone. Transcript is small → fast. Scales to hundreds of hibernated agents with no disk accumulation. |
| Separate state repo | Yes | Yes | Low | **No** | Versioned, diffable trajectory history (useful for training). But git fights append-heavy opaque blobs, and a repo has its own refs/history/truth → a *second coordination surface* the boss doesn't own. |

**Recommendation: GCS checkpoint by key** on the hibernate/revive hot path. Placement-free revival, cheap at rest, and it stays a dumb value store the boss owns (no competing source of truth). Reference the **key** (or PVC name if PV is chosen), **never the pod** — a deleted pod is terminal, there is no "resume pod" verb; revive is always *new pod, same key.*

If versioned agent-trajectory corpus is wanted for future training, use **both**: GCS for live hibernate/revive, plus an **async, out-of-band export** of finished sessions into a repo/dataset. Do not fuse the hot path with the archive — opposite access patterns; fusing them yields a slow revive and a messy archive at once.

### 5.3 The gitignore point (settled)
Session state does **not** go in the branch. Committing it bloats the branch, tangles code diffs with megabytes of transcript churn, and blocks clean shallow checkout. `.gitignore` keeps the local `.claude/` scratch out of commits — that is *hygiene*, not the persistence mechanism. Persistence is the external store, deliberately.

### 5.4 Domain-neutral schema (do this now — it is the only expensive-to-unwind decision)
Function signatures refactor cheaply later; a Postgres schema threaded through a live system full of hibernated agents does not. So the core tables get abstract types **now**, even though the only implementation is the dev workflow:

- **Lease** is over an abstract `resource_ref`, with overlap expressed as a **predicate function**, not a `file_path` column with a path-prefix glob. Today the ref *is* a file/module path and the predicate *is* prefix overlap — but the column and the logic don't say so.
- **Intent** stores `(goal, proposed_delta, affected_scope)` where `affected_scope` is a set of opaque `resource_ref`s. Not `intended_files`.
- The **core object** carries a `proposed_delta` handle and a `delta_state`, not a `pr_id` foreign key. The PR number lives in the **dev-materialization adapter's** side table, keyed to the delta handle.
- **Delta lifecycle states** are abstract: `PROPOSED → ACCEPTED → REALIZED → CONFIRMED` (+ terminal/kicked-back). In the dev instance these *map to* opened → merged → deployed → health-confirmed, and that mapping lives in the adapter, not the core enum.

This costs nothing today — you are writing those columns regardless — and it is the single layer that is painful to migrate later. Everything above it (git, PR, branch, GitHub, ephemeral env, pytest) stays concretely dev-shaped and lives behind the adapter. Do **not** build a second adapter or an abstraction framework now (§9); just keep the schema honest.

---

## 6. Components

### 6.1 Scheduler (upgrade of the existing supervisor)
Decomposes a goal into tasks that are **disjoint by construction** (partition along module boundaries) so leases rarely contend. This is enforcement's other half: leases *stop* collisions, decomposition *prevents* them from being requested. Evolve the existing cron supervisor into a conflict-aware scheduler + merge-queue driver.

### 6.2 Lease manager (pessimistic file leases)
- Postgres table: lease id, holder (agent id), path/module set, state, TTL, timestamps.
- No overlapping active leases.
- **Liveness via TTL + heartbeat** (reuse da_boss's existing fleet heartbeat infra). Dead agent's lease is reclaimed.
- **Granularity:** start with directory/module ownership for coarse partitioning + file-level leases within. Symbol-level (tree-sitter/LSP) is more precise but heavier; defer.
- **Cross-cutting changes** (rename a shared symbol, change a shared interface) cannot lease "one file." They take a **broad/exclusive lease, go first in the queue**, and everything else rebases after.
- **Do not hardcode the closed-world assumption.** The "boss has total authoritative knowledge" property (header, §1) is a *consequence of the current no-human-PR constraint*, not a truth the lease/state model should bake in. Read leases and actual state as things that *can* be changed by actors the boss didn't dispatch, even if today none are. Concretely: keep a path to ingest externally-observed claims on the shared resource (e.g. open PRs' touched files via the GitHub API) and treat them as held leases, so the model degrades gracefully if the constraint ever softens. Cheap to leave open now; structurally painful to add to a model that assumed sole authorship. (This is also the seam a non-development application would need — see §9 — so keeping it open costs nothing and forecloses nothing.)

### 6.3 Intent store
Per-PR persisted: task spec, plan, intended file set, semantic-edit list. Fed from **plan mode**. This is what powers re-materialization on base drift and author-driven conflict fixes. **Without this, leases only solve the easy half** and the AI-PR-merge problem remains everywhere a lease didn't cover.

### 6.4 Worker pods
- Job/pod per agent (da_boss's own "Phase 2: worker daemon polls boss" + "WebSocket relay").
- Clean checkout, lease attached, ephemeral the app env wired up.
- **Auth: API key only** — cannot `claude login` on ephemeral pods. Already works via `ANTHROPIC_API_KEY`, no code change.
- **Process-tree kill → delete the pod.** The pod boundary *is* the process tree; simpler than the current SIGKILL-the-tree logic.
- **Permission round-trip refactor.** `canUseTool` currently assumes runner + WebSocket in the same process. Remote pods mean escalation must round-trip worker → control plane → UI → back, with request/response correlation. Real work, easy to under-scope inside "pod separation."

### 6.5 Review agent (independent, adversarial, read-only)
- Judges whether a PR is good and adequately tested.
- **Cannot be the agent that wrote the code/tests** (self-marking).
- **Look-but-don't-touch:** cannot push to the branch it reviews.
- Emits **findings** (what is wrong), never **instructions** (what to do). See §7.
- Also owns test-adequacy / coverage judgment (§8) — same adversarial posture.

### 6.6 Orchestrator (global goal-alignment)
- Distinct axis from the reviewer. Reviewer asks "is this PR good." Orchestrator asks "is this the right thing to be doing **at all**." A change can be flawless and still be drift.
- Watches whether the fleet is still building toward the original goal; every PR can pass its own gate while the whole walks away from intent.
- On drift: revive author with the divergence, or pause the branch.

### 6.7 Merge queue
Serialize integration; test the **combined** result in an ephemeral env; kick back to author on failure. Build on GitHub's merge-queue primitive where possible rather than reinventing. Distinct from both the review agent and the deploy step — it is the *ordering discipline* between them.

### 6.8 Event bus (agents ↔ boss)
One pattern, several sources: CI red, deploy failure, reviewer verdict, orchestrator drift → **boss routes** → authoring agent revives with payload. **Not** a peer mesh. "Messaging queue between agents" in the earlier task list is really this: agents↔boss, not agent↔agent. A peer mesh reintroduces the coordination sprawl the whole design collapses into one authoritative place.

### 6.9 Ephemeral env provisioner — **SEAM 1**
Stands up a throwaway Phoenix + FastAPI + Celery + RabbitMQ + Redis + pgvector stack per branch. Lives *behind a call* the queue/review invoke, not inline in merge logic. the app-specific guts on the far side of that call.

### 6.10 Deploy confirmation — **SEAM 3**
Rolls to multi-region, watches health, emits deploy-success / deploy-failure events with a timeout. See §7 on why this is *not* an LLM-judgment gate in the merge-to-prod path.

---

## 7. Separation of powers (the recurring principle)

The invariant that holds the whole system honest: **the system stays honest exactly as long as no watcher gains a stake in what it watches.** Every fusion we rejected across design was a violation of this.

The rule sharpened: **the moment a step can hand work back, the giver and the fixer must be different parties, and the checker must be neither.**

| Job | Owner | Trust posture |
|---|---|---|
| Test execution + deploy execution | Deterministic CI/CD | Ground truth. No agent judgment *in the pass/fail decision path*. |
| Test orchestration, coverage adequacy, result triage | Independent review/test agent | Judgment — but can only make the gate *stricter* (see §8). |
| Code review | Independent reviewer agent (or human on exception) | Adversarial to author. Read-only. |
| Goal-alignment / drift | Orchestrator | Global, distinct axis from review. |
| Fixes (conflicts, kickbacks, deploy-failure repairs) | **Authoring agent** | Holds the intent. This is why the session survives to the last recoverable gate. |
| Routing events between all of the above | Boss | Owns none of the roles. |

### 7.1 Feedback flows as findings, not instructions
The reviewer/test agent can feed the author **directly** — as a **trigger with a payload** that revives the author. But the payload is a *description of the defect* ("this branch is untested, coverage here is nominal"), not a *remedy* ("add assertion X on line Y"). The author reads the finding and decides the fix. The reviewer authors nothing.

**Each review pass evaluates the current state from scratch**, against the goal — not "did you do the specific things I told you." Grading compliance with its own prior instructions is grading itself. That is the subtle re-entry of self-marking: not one-agent-does-both, but two-agents-so-coupled-the-wall-is-cosmetic.

### 7.2 The "deployment agent" clarified
Deploy is deterministic CI/CD. Deploy-*failure* fixes belong to the authoring agent. So a standalone "deployment agent" is only legitimate as a **rollout-health evaluator that can make the gate stricter** — never as an LLM making merge-to-prod decisions. If it can wave a failed rollout through on judgment, that is a reward-hacking surface; do not build that.

---

## 8. Test and verification model

The pipeline has a **deterministic floor** and a **judgment layer** on top. Getting the boundary right is the whole thing.

### 8.1 The floor (must stay hard boolean)
The **execution assertions themselves**. `assert balance == 100` held or it did not. Ground truth about behavior. Deterministic, replayable. No agent reads the output and *decides* whether a passing assertion passed. The judgment layer *reasons about* these results — you cannot evaluate results you do not trust the execution of.

### 8.2 The judgment layer (should NOT be boolean)
- **Orchestration:** run the fast unit subset for a docstring change, the full seeded-pgvector integration suite for a vector-layer change.
- **Coverage adequacy:** line coverage is a *bad* boolean — it says 87% of lines ran, nothing about whether they were the lines that matter or whether assertions checked anything real. It is Goodhart bait; an agent optimizing the number writes tests that satisfy the counter, not the intent. An agent judging *meaningful behavioral exercise* replaces a bad proxy with the thing the proxy failed to measure. Strictly better.
- **Triage:** "test failed" as a hard blocker hides real-regression vs. flaky-RabbitMQ-setup vs. expectation-legitimately-needs-updating. With Redis and network in the integration loop, flake is constant, and the boolean destroys information you need.

### 8.3 Direction of override (where the risk concentrates)
- Judgment making the gate **stricter** than the floor ("tests passed but coverage is theater → hand back"): pure upside. Do all of it.
- Judgment making the gate **more lenient** than the floor ("tests failed but the evaluator decided it's fine → merge"): this is the reward-hacking surface. Concurrent authoring agents all optimize to get merged; the moment "green" is something an agent can *argue for* rather than *produce*, the target softens from "make it work" to "convince the evaluator."

**Resolution for the necessary red→green case (flake):** it goes through **re-execution, not persuasion.** A failure judged flaky is **retried** (deterministic re-run) or **quarantined and flagged** — not waved through on say-so. Pass on retry → the boolean genuinely says green (you re-rolled ground truth, didn't override it). Fail again → it is real. Merge disposition still ultimately rests on a boolean, possibly re-executed or quarantine-adjusted; the *richness* lives in the verdict around it.

**The general principle (state it once, it recurs everywhere): the floor must be architecturally non-self-editable.** The judgment layer may *tighten* the gate without limit and *enrich* the verdict without limit, but the set of ground-truth facts it is allowed to *relax* must be fixed in code the judging agents cannot rewrite. This is what keeps a judging agent from redefining "healthy/passing" to stop flagging itself — reward-hacking's most durable form, where the system learns to suppress the signal instead of fix the fault. The invariant isn't "trust the agent less"; it's "the agent can reason *about* the floor and never *redefine* it." Any future component that lets judgment evolve over time inherits this requirement unconditionally: **evolvable mitigations on top, unrewritable invariants underneath.**

### 8.4 The artifact: a structured verdict, not a checkmark
Deterministic results + coverage facts (immutable ground truth) kept **provenance-separate** from adequacy assessment + triage (agent judgment). An auditor of any merge sees two distinct claims at two trust levels: "the assertions objectively passed" **and** "the reviewer judged the tests adequate."

### 8.5 Independence
The agent judging test adequacy **cannot** be the agent that wrote the tests. Same look-but-don't-touch role as code review — quite possibly the *same* reviewer agent, since "is this adequately tested" and "review this code" are the same posture.

---

## 9. General-purpose boundary

**Decision:** general-purpose *engine*, the app as the *first adapter*. We do **not** "build general now" (that guesses seams wrong and yields a framework nobody uses). We build the app **concretely** and refuse to let the app specifics into the core. "Clean core" and "does not prevent general purpose" are the *same property*, not two goals to balance.

### 9.1 The invariant (binary, inspectable) — two axes, not one
The naive version of this invariant catches Phoenix and pgvector but waves git and PRs through as if they were neutral. They are not neutral — they are *development*-neutral, which is narrower. So the boundary has **two** axes:

> **Axis 1 (application):** does an *the app* concept — Phoenix, pgvector, RabbitMQ, "region" — appear where the **scheduler, lease manager, intent store, merge queue, or lifecycle logic** can see it?
>
> **Axis 2 (domain):** does a *software-development-workflow* concept — git, branch, PR, merge, GitHub, diff, pytest — appear where those same five components can see it?

If either is yes, the core is coupled. The five components should see only **abstract types**: repo/target ids, `resource_ref`s, leases, session-keys, `proposed_delta` handles, `delta_state`s, and opaque `provision / toolchain / confirm-realization` calls. Axis 2 is the one the earlier drafts got wrong, and it is the one that matters most for keeping the core reusable, because "PR / merge / deploy" are the dev instance's *materialization* of the abstract operations "propose-delta / accept-delta / realize-delta," and a non-development application has none of them.

### 9.1b The two-layer split
- **Governance core** — stated entirely over the abstract types above. Knows nothing about git or Phoenix.
- **Dev materialization adapter** — git/PR/GitHub/branch/ephemeral-env/pytest live here, behind the seams, implementing the abstract operations concretely for the one instance we actually build.

This is the same seam discipline as Axis 1, one level up. The core doesn't gain an abstraction *framework* from this — it gains a *vocabulary*. The adapter stays concrete and single-purpose.

### 9.2 The three seams (named even with one implementation)
1. **Provision env** (§6.9)
2. **Worker toolchain image** (Elixir/OTP + Python for the app)
3. **Confirm deploy** (§6.10, multi-region GKE rollout)

Naming a seam is not building an abstraction — it is declining to smear the implementation across the caller. The interface stays an implicit function signature until a **second real repo** hands us the requirements. No plugin loader, no adapter registry, no config DSL, no second implementation until then. You extract the interface *from* two examples; you do not author it from imagination.

### 9.3 The cost
A small ongoing tax: every time the app specifics tempt a shortcut into one of the five core components, route it through the seam instead. If that discipline won't be held, the honest move is to stop claiming general and build a clean single-purpose the app tool — which beats a "general" system with the app leaking through every layer. The worst outcome is claiming general and building coupled.

---

## 10. Changes to existing da_boss

### 10.1 Reuse map (what already exists and gets repurposed)
| Existing primitive | New role |
|---|---|
| **Plan mode** | Intent capture: plan + intended file set + semantic-edit list → lease request + PR metadata |
| **Supervisor** (cron, resolves stale questions/plans) | Conflict-aware scheduler + merge-queue driver + orchestrator scaffolding |
| **`canUseTool` / permissions** | Merge-approval gate; but needs network round-trip for remote pods |
| **Fleet heartbeat** (NODE_ID, NODE_ROLE boss\|worker) | Lease liveness/TTL + worker registration |
| **Fleet schema** (Phase 1, schema-only) | Phase 2 distributed execution |
| **Process-tree SIGKILL** | "Delete the pod" (pod = process boundary) |
| **Session discovery** (`~/.claude/projects`) | Point at externalized GCS storage instead of local FS |
| **API-key auth path** | Worker auth (already works, no change) |

### 10.2 New build
Intent store · lease manager · scheduler decomposition · merge queue · event bus · ephemeral env provisioner (seam) · deploy confirmation (seam) · GCS session checkpoint/restore · Postgres migration · permission round-trip · per-user identity + audit (multiple devs logging in) · Helm chart + Workload Identity/Secret Manager · worker toolchain image.

---

## 11. GitHub integration and auth

- **PRs are the substrate.** Materialization + review + revert live on GitHub. Do not reinvent.
- **Merge queue** on GitHub's primitive where possible; da_boss holds the *extra* layer (leases, intent metadata, scheduling, auto-rebase agents).
- **Keys:** workers need to push branches and open PRs. Use a **GitHub App** (short-lived installation tokens) over long-lived deploy keys/PATs — scoped, revocable, per-repo. Delivered to pods via **Workload Identity + Secret Manager**, one slice of the broader secrets story. Avoid baking any long-lived credential into the worker image.
- Open human PRs are moot under the core constraint, but if the constraint ever softens, the lease manager can ingest open-PR touched-files from the GitHub API and treat them as held leases (humans get right-of-way, agents route around).

---

## 12. Sequencing

Ordered so each phase is usable and de-risks the next.

**Phase 0 — Foundations (no distribution yet)**
- SQLite → Postgres.
- Per-user identity + audit.
- Helm chart, Workload Identity, Secret Manager, GitHub App.

**Phase 1 — Distributed execution**
- Runner out of process → Job/pod. Worker daemon polls boss.
- GCS session checkpoint/restore (externalized state). Revive-on-different-pod proven.
- Permission round-trip refactor.
- Deploy control plane to its own namespace; workers to a tainted node pool.

**Phase 2 — Coordination**
- Lease manager (pessimistic file leases) + TTL/heartbeat reclaim.
- Scheduler decomposition into disjoint tasks.
- Event bus (agents ↔ boss).

**Phase 3 — Intent + integration**
- Intent store fed from plan mode.
- Re-materialize-intent-on-drift; author-fixes-own-conflict task type.
- Ephemeral env provisioner (SEAM 1).
- Merge queue testing combined result.

**Phase 4 — Verification + governance**
- Review agent (independent, read-only, findings-not-instructions).
- Test/verification model: deterministic floor + judgment layer + structured verdict + flake re-execution.
- Orchestrator (goal-alignment / drift).
- Deploy confirmation (SEAM 3) + lifecycle gating (lease-release-at-merge, session-destroy-at-last-recoverable-gate, TTL fallback).

**Phase 5 — Observability**
- Panoptes over the structured verdicts and event graph → auditable decision graph (intent → assertion result → adequacy call → drift check → kickback reasons). This is *enabled* by the provenance separation paid for in Phases 3–4.

---

## 13. Open decisions

1. **Throughput dial:** hold-lease-until-merge (safe, less parallel) vs. release-at-open + re-acquire-on-rebase (more parallel, rebase may queue behind whoever now holds the region). Re-materializing intent makes re-acquire cheap, which argues for release-at-open — but it is a real fork, pick deliberately.
2. **Session store:** GCS-by-key (recommended) vs. PV. If a versioned trajectory corpus for training is wanted, run both (GCS hot path + async archive export), not a state repo on the hot path.
3. **Lease granularity:** module/file to start; whether/when to go symbol-level (tree-sitter/LSP).
4. **Review on exception:** reviewer agent as advisory signal with human approving *intent* at dispatch and CI gating merge — vs. heavier agent-review. Lean: human approves plan at dispatch, CI gates, reviewer runs adversarially in between as advisory.
5. **How strict the deploy-health evaluator is**, and exactly which post-merge failures are agent-repairable vs. human-operational (sets whether the destroy boundary is merge or merged-and-deployed for a given change class).
6. **Exogenous-actor ingestion (§6.2):** *whether* to build the "observe claims the boss didn't create" path now or just leave the schema able to accept it. Recommendation: leave the door open in the data model now (cheap), build the ingestion only when a real second actor exists. Do **not** hardcode sole-authorship either way.

---

## Through-line

Separate the powers, give the party with the intent the job of fixing, keep a deterministic floor nobody can argue with (and that nobody — including the judging agents — can *redefine*), and let both the app **and** the git/PR workflow appear only behind named seams. The five core components — scheduler, leases, intent store, merge queue, lifecycle — see only abstract types: targets, resource-refs, deltas, sessions. Everything else is materialization behind an adapter. Build one thing well without poisoning the well; generality stays latent and free until a second real instance makes it concrete — and this repo describes only that one well-built thing, nothing downstream of it.
