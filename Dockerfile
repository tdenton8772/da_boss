# da_boss control plane (server + built UI). Control-plane only — no `claude`
# CLI / agent execution yet (that's the Phase 1 worker image).
#
# All runtime deps are pure JS (pg, express, …) so node:*-slim needs no build
# toolchain. Local target: docker-desktop kind (arm64 host → arm64 nodes, no
# cross-compile). For GKE (amd64) build via Cloud Build, not local buildx.

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

# ── runtime ──
FROM node:22-slim AS runtime
ENV NODE_ENV=production
# git: clone repos into /work; util-linux: flock for per-user shard mirror locking;
# universal-ctags: function line-ranges for the sidecar's semantic freeze-leases
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates util-linux universal-ctags python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*
# Pre-bake a local ONNX embedding model (fastembed — onnxruntime, NOT torch/
# tensorflow) so an agent pod running a repo whose MCP does self-contained semantic
# search works fully offline: the model is in the image, not downloaded per pod
# (~150-200MB, one-time per node at image pull). Fetch WITH network at build time,
# then force offline for runtime. Model is configurable; a repo's MCP reads it from
# FASTEMBED_CACHE_PATH. Neutral: no repo specifics baked in beyond a public model id.
ARG EMBED_MODEL=BAAI/bge-small-en-v1.5
ENV FASTEMBED_CACHE_PATH=/opt/fastembed
RUN python3 -m pip install --no-cache-dir --break-system-packages fastembed \
  && python3 -c "from fastembed import TextEmbedding; TextEmbedding('${EMBED_MODEL}', cache_dir='/opt/fastembed')"
ENV HF_HUB_OFFLINE=1
WORKDIR /app
# hoisted workspace node_modules live at the repo root
COPY --from=proddeps /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/ui/dist ./ui/dist
COPY --from=build /app/package.json ./package.json
EXPOSE 3847
# index.ts resolves ui/dist as ../../ui/dist from server/dist, so run from server/
WORKDIR /app/server
CMD ["node", "dist/index.js"]
