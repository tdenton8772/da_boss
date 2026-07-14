#!/usr/bin/env bash
# Deterministic collision scenario — no Claude, no tokens. Two SCRIPTED agents
# work the same repo: Jimmy edits `apply`; Johnny edits its caller (blast-radius
# overlap) AND forks `apply_v2` (lease evasion). We then read the REAL sidecar
# coordination out of Postgres: leases, contested symbols, strikes, evasion.
#
# Usage: TAG=<image-tag> bash scripts/scenario-collision.sh   (default: latest deployed)
set -euo pipefail
CTX=docker-desktop
NS=daboss
TAG="${TAG:-$(kubectl --context $CTX -n $NS get deploy daboss -o jsonpath='{.spec.template.spec.containers[0].image}' | sed 's/.*://')}"
echo "== using image da-boss:$TAG =="

psql() { kubectl --context $CTX -n $NS exec -i postgres-0 -- psql -U daboss -d daboss "$@"; }

BASE='int apply(int x) {\n  return x + 1;\n}\n\nint caller() {\n  return apply(2);\n}\n'
JIMMY_SCRIPT="{\"initRepo\":{\"a.cc\":\"$BASE\"},\"edits\":[{\"file\":\"a.cc\",\"find\":\"x + 1\",\"replace\":\"x + 2\"}],\"lingerMs\":90000}"
JOHNNY_SCRIPT="{\"initRepo\":{\"a.cc\":\"$BASE\"},\"edits\":[{\"file\":\"a.cc\",\"find\":\"return apply(2);\",\"replace\":\"return apply(3);\"}],\"appendFunctions\":[{\"file\":\"a.cc\",\"code\":\"int apply_v2(int x) { return x + 99; }\"}],\"lingerMs\":90000}"

echo "== cleanup any prior run =="
kubectl --context $CTX -n $NS delete pod scn-jimmy scn-johnny --ignore-not-found --now >/dev/null 2>&1 || true
psql -q -c "DELETE FROM leases WHERE holder_agent_id IN ('ag_scn_jimmy','ag_scn_johnny');
            DELETE FROM agent_commands WHERE agent_id IN ('ag_scn_jimmy','ag_scn_johnny');
            DELETE FROM agent_events WHERE agent_id IN ('ag_scn_jimmy','ag_scn_johnny');
            DELETE FROM token_usage WHERE agent_id IN ('ag_scn_jimmy','ag_scn_johnny');
            DELETE FROM agents WHERE id IN ('ag_scn_jimmy','ag_scn_johnny');" >/dev/null

echo "== seed two agents on the SAME repo =="
psql -q -c "INSERT INTO agents (id,name,prompt,cwd,state,priority,permission_mode,model,repo_url) VALUES
  ('ag_scn_jimmy','jimmy','scenario','/work','pending','medium','default','x','https://github.com/test/collision'),
  ('ag_scn_johnny','johnny','scenario','/work','pending','medium','default','x','https://github.com/test/collision');" >/dev/null

launch() { # name, agentid, script
  cat <<YAML | kubectl --context $CTX -n $NS apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata: { name: $1, namespace: $NS, labels: { app: daboss-scenario } }
spec:
  restartPolicy: Never
  initContainers:
    - name: sidecar
      image: da-boss:$TAG
      imagePullPolicy: IfNotPresent
      restartPolicy: Always
      command: ["node","dist/sidecar/index.js"]
      env:
        - { name: AGENT_ID, value: "$2" }
        - { name: WORK_DIR, value: "/work" }
        - { name: SIDECAR_LEASE_SECONDS, value: "15" }
        - { name: SIDECAR_HEARTBEAT_SECONDS, value: "10" }
        - { name: DATABASE_URL, valueFrom: { secretKeyRef: { name: daboss-app, key: DATABASE_URL } } }
      volumeMounts: [{ name: work, mountPath: /work }, { name: ws, mountPath: /ws }]
  containers:
    - name: agent
      image: da-boss:$TAG
      imagePullPolicy: IfNotPresent
      command: ["node","dist/worker/index.js"]
      env:
        - { name: AGENT_ID, value: "$2" }
        - { name: WORK_DIR, value: "/work" }
        - { name: WORKER_SCRIPT, value: '$3' }
        - { name: DATABASE_URL, valueFrom: { secretKeyRef: { name: daboss-app, key: DATABASE_URL } } }
      volumeMounts: [{ name: work, mountPath: /work }, { name: ws, mountPath: /ws }]
  volumes: [{ name: work, emptyDir: {} }, { name: ws, emptyDir: {} }]
YAML
}

echo "== launch scripted agents (jimmy edits apply; johnny edits caller + forks apply_v2) =="
launch scn-jimmy  ag_scn_jimmy  "$JIMMY_SCRIPT"
launch scn-johnny ag_scn_johnny "$JOHNNY_SCRIPT"

echo "== wait 55s for the sidecars to run a few lease cycles =="
sleep 55

echo ""
echo "===================== RESULTS ====================="
echo "--- active leases per agent (resource_ref = repo#symbol) ---"
psql -c "SELECT holder_agent_id, split_part(resource_ref,'#',2) AS symbol FROM leases WHERE state='active' AND holder_agent_id LIKE 'ag_scn_%' ORDER BY 1,2;"
echo "--- CONTESTED symbols (held by both) ---"
psql -c "SELECT split_part(resource_ref,'#',2) AS symbol, count(DISTINCT holder_agent_id) AS holders FROM leases WHERE state='active' AND holder_agent_id LIKE 'ag_scn_%' GROUP BY 1 HAVING count(DISTINCT holder_agent_id) > 1;"
echo "--- advisory strikes (evasion / frozen edits) ---"
psql -c "SELECT id, advisory_strikes FROM agents WHERE id LIKE 'ag_scn_%';"
echo "--- evasion events (the 🚩 forks) ---"
psql -c "SELECT agent_id, substring(data from 'content\":\"([^\"]{0,90})') AS event FROM agent_events WHERE agent_id LIKE 'ag_scn_%' AND data LIKE '%evasion%';"
echo "==================================================="
echo ""
echo "(pods scn-jimmy/scn-johnny + rows left in place for inspection; re-run to reset)"
