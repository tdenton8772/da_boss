# da_boss → GKE deploy runbook (daboss.example.com/daboss)

Target: cluster `YOUR_CLUSTER`, project `YOUR_PROJECT`, region `us-central1`,
namespace `daboss`. You run these (I can't `gcloud` from here). Prefix shell
commands with `!` in the da_boss session to run them here, or use your terminal.

## 0. Auth + context
```bash
gcloud auth login                       # dev.user@acme.com
gcloud config set project YOUR_PROJECT
gcloud container clusters get-credentials YOUR_CLUSTER \
  --project=YOUR_PROJECT --region=us-central1
kubectl config current-context          # gke_YOUR_PROJECT_us-central1_YOUR_CLUSTER
```

## 1. Artifact Registry repo (once)
```bash
gcloud artifacts repositories create daboss \
  --repository-format=docker --location=us-central1 --project=YOUR_PROJECT
```

## 2. Build + push images (Cloud Build — amd64; do NOT local-buildx)
```bash
export TAG=$(git rev-parse --short HEAD)
gcloud builds submit --project=YOUR_PROJECT --config=cloudbuild.daboss.yaml \
  --substitutions=_TAG=$TAG
# pushes  .../YOUR_PROJECT/daboss/da-boss:$TAG  and  .../daboss/elixir-test:1.18
```

## 3. Namespace + quota
```bash
kubectl apply -f k8s/gke/00-namespace.yaml
```

## 4. Secrets (real values — never commit)
```bash
# Postgres: pick a strong password, put the SAME value in DATABASE_URL below.
PGPW=$(openssl rand -hex 24)
kubectl -n daboss create secret generic daboss-postgres \
  --from-literal=POSTGRES_DB=daboss \
  --from-literal=POSTGRES_USER=daboss \
  --from-literal=POSTGRES_PASSWORD="$PGPW"

kubectl -n daboss create secret generic daboss-app \
  --from-literal=AUTH_PASSWORD="$(openssl rand -hex 24)" \
  --from-literal=SESSION_SECRET="$(openssl rand -hex 32)" \
  --from-literal=DATABASE_URL="postgres://daboss:${PGPW}@postgres:5432/daboss" \
  --from-literal=DABOSS_CIPHER_KEY="$(openssl rand -base64 32)"
```
(Later: move both to External Secrets Operator / Secret Manager.)

## 5. Postgres (skip its inline Secret — created above)
```bash
kubectl apply -f k8s/gke/10-postgres.yaml    # will say daboss-postgres unchanged
kubectl -n daboss rollout status statefulset/postgres
```

## 6. Control plane
```bash
sed "s/IMAGE_TAG/$TAG/g" k8s/gke/30-daboss.yaml | kubectl apply -f -
kubectl -n daboss rollout status deploy/daboss
```

## 7. Smoke test (before wiring the URL)
```bash
kubectl -n daboss port-forward svc/daboss 8080:3847 &
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/api/auth/me   # 200/401 = up
```

## 8. NetworkPolicies (only what the cluster's posture needs — read the file header)
```bash
kubectl -n daboss get networkpolicy               # what's already enforced?
kubectl apply -f k8s/gke/40-netpol.yaml
# sanity: an agent-labelled pod can reach the internet + postgres
```

## 9. Wire the URL: /daboss on the app ingress
- Edit the app's `k8s/gke/rate-limit.yaml` nginx ConfigMap: paste the block from
  `k8s/gke/nginx-daboss-snippet.conf` ABOVE the catch-all `location /`.
- `kubectl -n app apply -f k8s/gke/rate-limit.yaml` then reload nginx-rl
  (`kubectl -n app rollout restart deploy/<nginx-rl-deploy>`).
- Confirm the netpol `allow-nginx-to-boss` is applied (step 8).
- Visit **https://daboss.example.com/daboss** → login.

## 10. Onboard maintainers
- Each maintainer registers a local account, then in Settings adds THEIR OWN
  Claude credential + git credential (per-user; scoped to their access).
- Set the Supervisor Credential (Settings, admin) to a designated admin so the
  reviewer/supervisor have a Claude credential.

## 11. Build identity (kaniko on-demand image builds) — LEAST PRIVILEGE

Needed only if a repo uses on-demand images: a pipeline phase/service `build:` or a
repo's `.daboss/agent.Dockerfile` (self-provisioning agent images). da_boss builds
these with kaniko in-cluster; the build pod needs an identity that can **pull the
base + push the result** to the AR repo — and **nothing else** (no deploy, no cluster
access). Dedicated GSA/KSA, ONE role: `roles/artifactregistry.writer`.

```bash
PROJECT=YOUR_PROJECT
# GSA with ONLY Artifact Registry write on the daboss repo (writer = pull + push).
gcloud iam service-accounts create daboss-build --project=$PROJECT \
  --display-name="da_boss kaniko image builder"
gcloud artifacts repositories add-iam-policy-binding daboss \
  --location=us-central1 --project=$PROJECT \
  --member="serviceAccount:daboss-build@$PROJECT.iam.gserviceaccount.com" \
  --role="roles/artifactregistry.writer"
# Workload Identity: let the daboss/daboss-build KSA impersonate that GSA.
gcloud iam service-accounts add-iam-policy-binding \
  daboss-build@$PROJECT.iam.gserviceaccount.com --project=$PROJECT \
  --role="roles/iam.workloadIdentityUser" \
  --member="serviceAccount:$PROJECT.svc.id.goog[daboss/daboss-build]"
# k8s side (da_boss can do these itself):
kubectl -n daboss create serviceaccount daboss-build
kubectl -n daboss annotate serviceaccount daboss-build \
  iam.gke.io/gcp-service-account=daboss-build@$PROJECT.iam.gserviceaccount.com
kubectl -n daboss set env deploy/daboss DABOSS_BUILD_SERVICE_ACCOUNT=daboss-build
```
Permissions summary — the build identity needs **exactly** `roles/artifactregistry.writer`
on the `daboss` repo. Do NOT reuse the deploy SA (that one can reach the cluster; a
builder shouldn't). If `DABOSS_BUILD_SERVICE_ACCOUNT` is unset or the grant is missing,
kaniko can't push → da_boss falls back to the generic base image (agents still run,
just without the repo's declared toolchain).

## Notes / follow-ups
- `test-web` phase image: on GKE point the app's `.daboss/pipeline.yaml` at
  `us-central1-docker.pkg.dev/YOUR_PROJECT/daboss/elixir-test:1.18` (not the local
  `daboss-elixir-test:1.18`). The `test` (workers) phase uses public python, no change.
- Redeploys: bump `_TAG`, rebuild (step 2), re-`sed`+apply (step 6). `:latest`-style
  tags need `kubectl rollout restart deploy/daboss`.
- Deferred hardening: External Secrets, tainted worker node pool, Cloud SQL, Okta
  OIDC (set AUTH_MODE=oidc + provider config), GitHub App tokens, Workload Identity
  for the deploy phase.
