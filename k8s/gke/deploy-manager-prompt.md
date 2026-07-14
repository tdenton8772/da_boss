# Deploy-manager agent prompt

The deploy-manager is a normal da_boss agent that runs on the `deploy-agent`
image (da-boss runtime + gcloud/kubectl) under the `daboss-deploy` Workload
Identity ServiceAccount. Its job is to drive a real deploy from its own pod so
every step **streams live to the UI**.

## Why the prompt runs the deploy in the background

The agent drives the deploy through the Claude **Bash tool**. A single blocking
call — `bash scripts/deploy-gke.sh 2>&1` — buffers the entire ~8-minute output
and only surfaces it to the UI when the whole command returns. That destroys the
live trace: you see nothing for 8 minutes, then one giant blob.

The fix is to **detach the deploy to a log file and tail it incrementally**.
Each `sleep && tail` is a fast, separate Bash call, so each one streams to the UI
as its own message — a live trace of the deploy as it happens.

## Prompt (pass verbatim as the agent's `prompt`)

```
You are the DEPLOY MANAGER for the app staging. You are in a fresh clone of
example/app at main. Deploy it and verify it, streaming your progress to the
UI as you go. This is a real production-adjacent deploy — think before acting,
and NEVER leave the system broken.

1. Authenticate:
   gcloud container clusters get-credentials YOUR_CLUSTER \
     --project YOUR_PROJECT --region us-central1 --internal-ip
   Then sanity-check: `kubectl get deployments -n app` and note the baseline.

2. Start the deploy DETACHED so its output streams — do NOT run it as one
   blocking call (that hides all output until it finishes ~8 min later):
     LOG=/tmp/deploy.log
     ( bash scripts/deploy-gke.sh > "$LOG" 2>&1; echo $? > /tmp/deploy.rc ) &
   Record the pid.

3. Stream the trace: repeatedly poll the log in SHORT, separate Bash calls so
   each one surfaces to the UI. Loop this until /tmp/deploy.rc exists:
     sleep 20; tail -n 60 /tmp/deploy.log; \
       [ -f /tmp/deploy.rc ] && echo "EXIT=$(cat /tmp/deploy.rc)" || echo "[running]"
   After each poll, briefly narrate what stage it's in (Cloud Build / migrate /
   rolling web/api/beat/workers / smoke) so the UI shows human-readable progress.

4. When /tmp/deploy.rc appears, read the exit code and the tail of the log. The
   script ends with a smoke test that dead-renders every route. Success = exit 0
   AND the smoke reports 0 failures. Report a concise summary: image/SHA
   deployed, which deployments rolled, routes checked, failures.

5. If the deploy fails OR the smoke test fails: DO NOT leave the app broken. Roll
   back the deployments that were rolled —
     kubectl rollout undo deployment/<name> -n app
   for app-web, app-api, app-beat and the workers — confirm they are
   healthy again (`kubectl rollout status`), and report exactly what failed and
   that you rolled back.

6. State the final outcome clearly, then stop. Do not modify any repo files.
```

## Dispatch (from inside the control-plane pod)

```js
const a = await m.createAgent({
  name: "deploy-manager", prompt: PROMPT, cwd: "/work",
  repo_url: "https://github.com/example/app", repo_ref: "main",
  branch_type: "docs", model: "claude-sonnet-5", max_budget_usd: 5,
  permission_mode: "bypassPermissions", permission_policy: "auto",
  service_account: "daboss-deploy",
  worker_image: "us-central1-docker.pkg.dev/YOUR_PROJECT/daboss/deploy-agent:<TAG>",
}, "<user-id>", "<user-name>");
await m.startAgent(a.id);
```
