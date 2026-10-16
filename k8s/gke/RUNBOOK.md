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

Builds run on Cloud Build, never locally: GKE nodes are amd64, and cross-building
on an arm Mac under QEMU is slow and corrupts caches. The build config,
`cloudbuild.daboss.yaml` at the repo root, is **gitignored** because it names the
real project and registry. Create yours from the shape below; its header comments
are the full reference.

```bash
export TAG=$(git rev-parse --short HEAD)    # commit + push first — the tag IS the commit
gcloud builds submit --project=YOUR_PROJECT --config=cloudbuild.daboss.yaml \
  --substitutions=_TAG=$TAG
```

What one build produces (Artifact Registry `us-central1-docker.pkg.dev/YOUR_PROJECT/daboss`):

| Image | Source | Used by |
|---|---|---|
| `da-boss:$TAG` | `Dockerfile`, target `runtime` | boss, orchestrator, and every agent pod (`WORKER_IMAGE`) |
| `deploy-agent:$TAG` | `Dockerfile`, target `deploy-agent` (runtime + gcloud/kubectl) | deploy-manager agents (`DABOSS_DEPLOY_AGENT_IMAGE`) |
| `da-boss-os:$TAG` | `Dockerfile`, target `os` (OS + node, no da_boss code) | base for repos' agent toolchain images (`DABOSS_AGENT_BASE_IMAGE`) |
| `elixir-test:1.18` | `images/elixir-test` | pipeline test phases; rebuilt only when its Dockerfile changes (tracked by a `src-<hash>` tag) |

How it's built — the parts worth keeping if you write your own config:

- **BuildKit with a registry cache.** Each Cloud Build runs on a fresh VM, so
  nothing is cached unless the build brings it. The steps use `docker buildx` on a
  `docker-container` builder with
  `--cache-from/--cache-to type=registry,ref=…/buildcache:<target>,mode=max,image-manifest=true,oci-mediatypes=true`.
  `mode=max` caches layers from every stage (npm ci, apt, gcloud), not only the
  final one. A code-only change then reruns just tsc/vite and the final COPY, and
  unchanged layers keep their digests, so the push skips them.
  `image-manifest=true,oci-mediatypes=true` is what Artifact Registry needs to store
  the cache.
- **The two app images build in parallel** on one shared builder, so their common
  stages (`build`, `proddeps`, `app`, `os`) are built once. In `deploy-agent` the
  gcloud layer sits *below* the app, so app changes never rebuild or re-push it.
- **Push the `os` stage too** (`da-boss-os`). Repo agent images are built on it and
  keyed by its *layer digests*, which the cache keeps stable, so a da_boss deploy
  doesn't rebuild them (one that changes the `os` stage does — the boss pre-builds
  them right after startup, so agents don't wait); the agent pod mounts da_boss's code from `WORKER_IMAGE` as
  a read-only image volume (needs Kubernetes ImageVolume — on by default in 1.35;
  leave `DABOSS_AGENT_BASE_IMAGE` unset on clusters without it).
- **Static images are skipped when unchanged**: hash the Dockerfile and check for
  the `src-<hash>` tag with `docker buildx imagetools inspect` before building.
- In `cloudbuild.yaml`, shell variables must be written `$$var`, because Cloud
  Build treats `$var` as a substitution.

Local (docker-desktop kind) builds stay a plain `docker build -t da-boss:<tag> .`,
which builds the default `runtime` target.

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

## 12. Dev environments (optional)

A repo that ships `.daboss/dev.yaml` can get per-change dev pods: da_boss runs the
branch in the repo's own namespace (where its secrets, config and service account
live), and the human port-forwards to it and works with their local Claude. da_boss
needs, per app namespace:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: daboss-dev-envs, namespace: YOUR_APP_NAMESPACE }
rules:
  - { apiGroups: ["apps"], resources: ["deployments"], verbs: ["get", "list", "create", "update", "delete"] }
  - { apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] }
  - { apiGroups: [""], resources: ["pods/exec"], verbs: ["get", "create"] }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: daboss-dev-envs, namespace: YOUR_APP_NAMESPACE }
subjects: [{ kind: ServiceAccount, name: daboss, namespace: daboss }]
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: daboss-dev-envs }
```

RBAC can't scope by name, so this covers every Deployment and pod in that namespace;
da_boss only touches the `dev-*` Deployments it created. It gets no Secret access.
Then set on the control plane (30-daboss.yaml):

- `DABOSS_DEV_NAMESPACES=YOUR_APP_NAMESPACE` — the namespaces dev.yaml may target.
- `DABOSS_DEV_KUBE_CONTEXT=<the kubectl context name your users have>` — so the
  port-forward command da_boss shows is copy-paste exact (otherwise it shows `$CTX`).
- `DABOSS_DEV_KUBE_SETUP=<one-time command that creates that context>` (optional) —
  shown verbatim as the panel's "once per laptop" step, e.g. your cloud's
  get-credentials command.

Users need their own kubectl access to the namespace to port-forward (and
`pods/exec` to use the copy-files command).

## Notes / follow-ups
- `test-web` phase image: on GKE point the app's `.daboss/pipeline.yaml` at
  `us-central1-docker.pkg.dev/YOUR_PROJECT/daboss/elixir-test:1.18` (not the local
  `daboss-elixir-test:1.18`). The `test` (workers) phase uses public python, no change.
- Redeploys: bump `_TAG`, rebuild (step 2), re-`sed`+apply (step 6). `:latest`-style
  tags need `kubectl rollout restart deploy/daboss`.
- **One tag, one apply.** `30-daboss.yaml` sets the boss image, the orchestrator
  image, `WORKER_IMAGE`, `DABOSS_DEPLOY_AGENT_IMAGE` and `DABOSS_AGENT_BASE_IMAGE`
  from the same `IMAGE_TAG`.
  Never bump one by hand (`kubectl set image`, `kubectl set env`): the rest keep
  running old worker code.
- Deferred hardening: External Secrets, tainted worker node pool, Cloud SQL, Okta
  OIDC (set AUTH_MODE=oidc + provider config), GitHub App tokens, Workload Identity
  for the deploy phase.
