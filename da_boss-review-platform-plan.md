# da_boss → Agent-Driven Review as a First-Class, Testable Capability

**Target:** make "an *agent* (not a person) requests a review of an incoming change, and da_boss produces a trustworthy verdict" a first-class, headless-drivable, **testable** operation — instead of the hand-driven backdoor used to get the first security review done.

**Core constraint (design premise):** the requester of a review may itself be an automated orchestrator, not a human at a browser. The whole design has to survive there being no interactive session behind the request. That is the property that today's implementation does *not* have.

**Scope and neutrality.** This describes only the OSS framework capability. **Git-as-the-delta-holder is an accepted assumption** (settled early) — so git vocabulary (branch, PR, merge, ref) is fine in the core. The neutrality line is one level up: the **forge host** (GitHub today, GitLab tomorrow — the pulls API, `refs/pull/N/head`, cross-repo detection) is the **adapter** (distributed plan §2.3 `dev_delta_materialization`). No SVN/non-git abstraction is a goal. Review *criteria* (what makes a HOLD) are supplied by the caller, never framework code. Nothing below names or embeds a downstream application, security rubric, or proprietary mechanism. Keeping it forge-neutral is the binary test in §8.

---

## 1. The problem we are actually solving

Two things got conflated while getting the first review done, and only one of them is hard.

**Requesting and recording a review** is the easy one, and it should be a boring, well-typed operation: given a delta, produce `{recommendation, rationale}`, record it, gate on it, attribute it. A person clicking a button and an orchestrator calling an API should hit the *same* path.

**Trusting the review** is the hard one, and it has two independent failure surfaces:
1. **Orchestration correctness** — does the machinery around the reviewer behave? (Does a HOLD actually block the merge? Does the reviewer stay read-only? Does the verdict survive storage? Does a fork delta get fetched safely?)
2. **Review quality** — does the reviewer actually *catch* the class of defect we care about?

These need completely different test strategies (§4). The mistake today is that neither is tested, because both are welded to a single untestable step: "a pod runs a model against a real repo."

## 2. Why today's approach cannot be tested (evidence, not theory)

Today a review is smuggled in as *another agent* carrying `review_of_agent_id`, and the only way to run one is to spawn a pod that runs the model live. There is no seam between "decide + record + gate" and "actually run the model." Consequence: the orchestration has **no tests**, and every orchestration bug shipped to production and was found by hand:

| Bug found live this session | It is pure orchestration logic | Offline-testable behind a seam? |
|---|---|---|
| Review agent **pushed** the reviewed (untrusted, fork) code to origin | yes — a push-gate condition | yes |
| Verdict **truncated at 4000 chars**, dropping the `RECOMMENDATION` line | yes — a storage cap | yes |
| Fork delta clone failed (`pathspec 'patch-1'`) | yes — ref resolution | yes |
| Fork delta resolved without noticing it was cross-repo | yes — a forge-adapter classification | yes (already mocked in `forge.test.ts`) |

**All four are deterministic logic that never needed a live model.** They shipped because there was nowhere to test them without one. That is the whole argument for the seam.

## 3. The design

### 3.1 A review is a first-class entity, not a side-effect of an agent

Give it its own row so it can be requested, queried, gated on, and **asserted in tests** independent of whether an internal agent exists:

```
reviews:
  id                pk
  delta_id          fk → the delta/intent under review (NOT a PR url)
  requested_by      principal id (human OR bot)
  runner            which ReviewRunner produced it (see §3.2)
  status            pending | running | done | error
  recommendation    merge | fix | hold               (git is assumed; keep the native verbs)
  rationale         text (uncapped — see the truncation lesson)
  created_at, completed_at
```

`delta_id` keeps it neutral: the forge adapter maps a delta to `refs/pull/N/head`; the `reviews` table never sees a PR number. API: `POST /api/reviews {delta}` → `GET /api/reviews/:id`.

### 3.2 SEAM: `ReviewRunner` (the load-bearing decision)

This is the equivalent of the distributed plan's SEAM-1 provisioner, applied to review:

```ts
interface ReviewRunner {
  run(input: ReviewInput): Promise<Verdict>   // {recommendation, rationale, meta}
}
```

- **Production impl** — dispatches the read-only reviewer pod, checks out the delta's materialized head, parses the recommendation. All the live/k8s/model weight lives *here and only here*.
- **Fake impl** — returns a scripted `Verdict` (or replays a recorded transcript). Injected in tests.

The orchestration (§3.1 lifecycle: request → run → record → gate → notify) depends only on the interface. That makes the entire pipeline testable with pg-mem + the fake — no cluster, no model, no creds.

The `Verdict` is a **result handed back to the caller**, not a framework verdict on the work — the caller evaluates it against its own criteria (§4). So `Verdict` must carry enough for that judgment (recommendation + rationale + the evidence it rests on), and the seam must support the caller's next move: accept, re-request with a refined rubric, or escalate.

### 3.3 Two surfaces on one core: MCP for agents, REST for humans

The requester is usually an *agent*, so the primary surface is **MCP tools**, not "teach an agent to speak authenticated HTTP." The human surface (the UI button, REST) stays — both are thin adapters over the *same* `ReviewRunner` seam and `reviews` entity.

- **Agent surface (MCP):** `list_open_deltas`, `request_review(delta, rubric)`, `get_verdict(id)`, `record_finding(...)`. The **supervisor is the boss/orchestrator** — it already does boss-side (serialized) Claude evaluation; making it the thing that decides *what* to review and *reads* the verdicts is the natural fit. Review *execution* stays in pods, so this adds no boss-Claude contention beyond the supervisor's own reasoning.
- **Human surface (REST + UI):** the 🔍 Queue review button, `POST/GET /api/reviews`.

**Principal model — build both:**
- a **bot / test-runner principal** with its *own* creds (generalize the existing `TEST_USER_ID`/`ensureTestUser`, which the scenario runner already acts as), and
- an **act-as-me token** (resolves to a real user, runs on their creds/credits).

Both resolve in the auth/session layer *before* the interactive-session check, so an MCP connection or a `Bearer` REST call carries a principal, scoped (`review:create`, `review:read`), attributed, and audited.

```
principals:  id, kind (user|bot), ...
api_tokens:  id, principal_id, token_hash, scopes[], created_at, revoked_at
```

**Transport — poll now, stream later (intended direction).** Shipped: stateless
Streamable HTTP at `/mcp` with `enableJsonResponse` (plain JSON) — `request_review`
returns immediately (`running`), the caller polls `get_verdict`. This works through
the *existing* shared `/daboss/` nginx route with no infra change, and it's robust
(a dropped connection just re-polls). But the review already emits a **live event
stream** on the Postgres `NOTIFY` bus (`daboss_agent_event`, the same one the UI
consumes). The better shape is a streaming `watch_review` tool / MCP progress
notifications that **tap that existing bus** and forward the reviewer's reasoning as
it happens — additive, no new event plumbing. Its one blocker is **not da_boss
code**: SSE needs `proxy_buffering off` on the shared `/daboss/` nginx location
(which the app's own `/mcp` route already sets) — an the app-infra change. Design
nuance: streaming gives the caller *mid-process* visibility, which slightly softens
the "worker produces, caller judges the *result*" boundary (§4) — useful, but adopt
it deliberately.

**Path note:** da_boss's MCP is `/daboss/mcp`; the app's Downstream MCP is `/mcp` — separate
service, prefix, auth, and tools. No collision (verified live).

### 3.4 The rubric is an input from the caller, not static config

The reviewing *criteria* are supplied by the requesting agent at call time — `request_review(delta, rubric)` — reusing the per-agent `supervisor_instructions` mechanism that already exists. The framework ships a neutral default reviewer; the supervisor (or any caller) sets the rubric dynamically per request. This is more flexible than a config table **and** keeps every deployment-specific / proprietary rubric out of the OSS core entirely — it's never in the repo, it's passed in.

### 3.5 The security contract of a review (encode it, don't rediscover it)

A review is **read-only against possibly-untrusted input**. The runner's production impl must guarantee, as invariants the tests assert:
- checks out the delta head via the adapter's read-only ref (`refs/pull/N/head` for GitHub) — **never** adds the contributor's remote;
- **never pushes and never opens a delta of its own** (the trust-laundering hole);
- for an *external* (cross-origin) delta, runs **without** blanket tool auto-approval, so an injected `push`/exfil escalates to a human instead of executing;
- treats file/diff/comment content as data, not instructions (injection defense).

These are not prose guidance — §4 turns each into a test.

## 4. Testability — the judgment is the caller's; we test only the plumbing

Two different things get called "testing" here, and only one is a test-suite concern.

**The judgment — "did this work succeed?" — is not a framework assert.** In an agent system the *assert is the returned result, evaluated by the calling agent against its own criteria*. A review is a job; it returns a verdict + rationale to whoever dispatched it (the supervisor, another agent, or a human via the button); that caller judges the result against the criteria it holds — the rubric it passed in (§3.4). Pass/fail is an intelligent judgment, not a string-match, so non-determinism is a non-issue. And it **composes**: each caller is itself a callee to the caller above it, topping out at a human for the highest-stakes gate. There is no external oracle — the caller *is* the oracle, live. (This is why a "golden set" was the wrong instinct: it tried to make the framework the oracle.)

**The plumbing — does the result get delivered and do the gates fire — is deterministic**, and that is all the test suite owns. The two layers below.

### 4.1 The layers

| Layer | Runs | Uses | Proves | Status |
|---|---|---|---|---|
| **Orchestration** | CI, every commit | fake `ReviewRunner`, pg-mem | logic: gating, no-push, verdict parse/store, fork→read-only-ref, idempotency, attribution | **missing — the seam unlocks it** |
| **Contract** | CI | mocked forge/k8s clients | forge adapter + API/MCP behave (cross-repo detection) | **partial** — `forge.test.ts` |

### 4.2 What layer 1 must assert (the regression net)

Direct tests for each bug in §2, plus the §3.5 invariants:
- a `hold` recommendation makes the merge path refuse (and refuse to merge silently);
- a review principal's run **produces no push and no PR** even when its working tree is ahead of base;
- a rationale longer than the old cap round-trips intact (verdict line preserved);
- an external delta resolves to the read-only ref and to the non-auto-approve mode;
- requesting a review twice does not stack runners (idempotency).

### 4.3 The judgment is the caller's, and it composes

A review returns a structured result (verdict + rationale + evidence) to whoever requested it. That caller evaluates it against the criteria it supplied and decides: **accept**, **refine-and-re-request**, or **escalate**. The framework's job is to make the result *evaluable* (enough structure for a caller to judge it) and to support that loop (idempotent re-dispatch, escalation) — never to pronounce the review "correct." The chain of callers tops out at a human for the highest-stakes decision (the deploy gate).

The existing `Live Test Scenarios` `verify()` is a *hardcoded, primitive* instance of "caller evaluates the returned result" — fine for fixed behavioural paths (interrupt/steer). The general case is the calling *agent* judging live against its own criteria, which is a runtime property of the system, not a test artifact.

### 4.4 Blind by construction — why this beats a unit test

A unit test encodes the expected output, so the thing under test can be shaped to satisfy exactly it (Goodhart / teaching to the test), and it only catches the cases you already enumerated. Here the worker **never sees the expected answer and doesn't know it's being evaluated** — it produces genuine work against what looks like an ordinary task, and an independent caller judges the *actual* result against criteria the worker never received. That tests the real, generalizing capability, not a memorized case, and it's immune to gaming because there's nothing to see.

This only holds if blindness is **actively protected** — the load-bearing invariant:
- The **expected outcome** and the **"this is a test" signal** must never enter the worker's context. A scenario is presented as ordinary work (the existing harness already does this).
- The **rubric is a lens, not an answer.** Telling a reviewer *what to look for* ("evaluate for exposure") is fine; passing it *the verdict* ("the answer is `hold`") collapses the evaluation back into a unit test. Expected results stay with the caller, never with the worker.

**Scope boundary:** blind evaluation is for judging **work and judgment**. The mechanical invariants (§4.2 — `hold` gates the merge, a reviewer never pushes) are the opposite case — you *do* know the exact expected behaviour and *want* it pinned, so deterministic tests are correct there. Blind eval for the judgment; unit tests for the plumbing. Not in competition.

## 5. Migration from today (no behavior change, then delete the backdoor)

1. Extract the current `dispatchReviewAgent` + `applyReviewResult` flow behind `ReviewRunner` (production impl) with **identical** behavior. Land the fake + layer-1 tests. *Now the bugs we fixed by hand have regression tests.*
2. Introduce the `reviews` entity; have the production runner write it. Keep the legacy `review_of_agent_id` linkage as a view/shim during transition.
3. Add the principal + token layer (§3.3): the **bot** principal and the **act-as-me** token, resolving before the session check.
4. Expose the **MCP tools** over the core (`request_review`/`get_verdict`/…) for the supervisor/agents; keep `POST/GET /api/reviews` + the button for humans. Same core underneath.
5. Retire the `kubectl exec` dispatch entirely — it was only ever a bootstrap.

## 6. Suggested order

`ReviewRunner` seam + layer-1 tests (correctness now) → `reviews` entity (queryable) → principal + tokens, **both** kinds (agent-drivable) → MCP surface for the supervisor + REST/button for humans. The first step pays for itself immediately; each later step is independently shippable.

## 7. Decisions (all resolved 2026-07-13)

- **Principal model → BOTH.** A `bot`/test-runner principal (its own creds; generalizes `TEST_USER_ID`) *and* an act-as-me token.
- **Rubric → caller-supplied.** The requesting agent passes the rubric per call (§3.4); no config file, no `review_policies` table.
- **Agent surface → MCP.** The supervisor (the boss) drives review via MCP tools; REST/UI is the human surface on the same core.
- **Recommendation vocabulary → keep `merge/fix/hold`.** Git-as-delta-holder is an accepted assumption, so the git-native verbs are core, not a leak.
- **The assert is the caller's, not the framework's.** A job returns a result; the calling agent evaluates it against its own criteria (the rubric it passed in), composing up to a human at the top. The framework delivers *evaluable* results and supports the accept / refine-and-re-request / escalate loop; deterministic tests cover only that plumbing (§4). No "golden set" — the caller is the live oracle.

## 8. Forge-neutrality check (the binary test)

Git is assumed; only the **forge host** must be swappable. The core passes if:
- [ ] The `reviews` table and `ReviewRunner` interface name no host-specific concept — no `github`, no `refs/pull/...`; git terms (`merge`, `branch`, `delta`) are fine.
- [ ] Every `refs/pull/N/head`, "cross-repo," and pulls-API call lives in the forge **adapter** (§2.3), so a GitLab adapter is a drop-in.
- [ ] No review *criterion* exists in framework source — the rubric is always caller-supplied (§3.4).
- [ ] The framework builds and its tests pass with the forge adapter swapped for a fake — no GitHub dependency in the core path.
