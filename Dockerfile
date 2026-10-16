# da_boss image: the control plane (server + built UI) and the pod worker — one
# image, two targets:
#   runtime       (default, last stage) — boss, orchestrator, and agent pods
#   deploy-agent  — the same app plus gcloud + kubectl, for deploy-manager agents
#
# All runtime deps are pure JS (pg, express, …) so node:*-slim needs no build
# toolchain. Local target: docker-desktop kind (arm64 host → arm64 nodes, no
# cross-compile): `docker build -t da-boss:<tag> .` builds `runtime`. For GKE
# (amd64) build via Cloud Build, not local buildx — see k8s/gke/RUNBOOK.md §2.
#
# Stage order is for caching: everything slow and stable (npm ci, apt, gcloud)
# sits in layers that only change when the lockfile or the package list does, so
# a code-only change rebuilds just the tsc/vite step and the final COPY.

# ── build: install all deps, build server (tsc) + ui (vite) ──
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY ui/package.json ui/package.json
RUN npm ci
COPY . .
# Base path the UI is served under. Root by default; GKE builds with /daboss/ so
# it lives at daboss.example.com/daboss.
ARG VITE_BASE=/
ENV VITE_BASE=$VITE_BASE
RUN npm run build

# ── prod deps only (no devDependencies) ──
FROM node:22-slim AS proddeps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY ui/package.json ui/package.json
RUN npm ci --omit=dev

# ── app: the finished /app tree, shared by both targets ──
FROM scratch AS app
# hoisted workspace node_modules live at the repo root
COPY --from=proddeps /app/node_modules /app/node_modules
COPY --from=build /app/server/dist /app/server/dist
COPY --from=build /app/server/package.json /app/server/package.json
COPY --from=build /app/ui/dist /app/ui/dist
COPY --from=build /app/package.json /app/package.json

# ── os: the runtime OS layer ──
FROM node:22-slim AS os
ENV NODE_ENV=production
# git: clone repos into /work; util-linux: flock for per-user shard mirror locking;
# universal-ctags: function line-ranges for the sidecar's semantic freeze-leases
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates util-linux universal-ctags \
  && rm -rf /var/lib/apt/lists/*
# NOTE: this base stays generic on purpose — no per-repo toolchain (python, embedders,
# graphics libs, …). A repo that needs more declares it in `.daboss/agent.Dockerfile`
# (FROM ${DABOSS_BASE} + its deps); da_boss builds that agent image once, keyed by the
# base + that Dockerfile, and runs the repo's agents in it. See agent/agent-image.ts.

# ── deploy-agent: runtime + gcloud + kubectl ──
# A deploy-manager agent drives a real deploy from its own pod and streams every
# step to the UI like any other agent. Selected per agent via worker_image
# (DABOSS_DEPLOY_AGENT_IMAGE); runs under the Workload-Identity deploy SA. The
# gcloud layer sits BELOW the app, so app changes never rebuild or re-push it.
FROM os AS deploy-agent
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl gnupg apt-transport-https \
 && curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" > /etc/apt/sources.list.d/google-cloud-sdk.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends google-cloud-cli google-cloud-cli-gke-gcloud-auth-plugin kubectl \
 && rm -rf /var/lib/apt/lists/*
ENV USE_GKE_GCLOUD_AUTH_PLUGIN=True
COPY --from=app /app /app
EXPOSE 3847
# index.ts resolves ui/dist as ../../ui/dist from server/dist, so run from server/
WORKDIR /app/server
CMD ["node", "dist/index.js"]

# ── runtime (default target — keep it LAST so a plain `docker build` picks it) ──
FROM os AS runtime
COPY --from=app /app /app
EXPOSE 3847
WORKDIR /app/server
CMD ["node", "dist/index.js"]
