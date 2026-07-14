# Reusable Elixir test toolchain for da_boss pipeline `test-web`-style phases.
# Domain-neutral: bakes the slow/fragile bootstrap (build tools, cmake, and Hex +
# rebar3 installed from GitHub to dodge OTP 27's strict TLS rejection of the
# hex.pm CDN cert) so a phase command is just `mix deps.get && ... && mix test`.
# Repo deps are NOT baked (they're per-repo); they resolve at runtime from mix.lock.
#
# Build (into the docker-desktop/kind image store):
#   docker build -t daboss-elixir-test:1.18 images/elixir-test
# A pipeline phase then sets: image: "daboss-elixir-test:1.18"
FROM hexpm/elixir:1.18.1-erlang-27.2-debian-bookworm-20250113-slim

RUN apt-get update -y \
 && apt-get install -y --no-install-recommends build-essential git curl ca-certificates cmake \
 && rm -rf /var/lib/apt/lists/*

# Hex from GitHub + rebar3 from its GitHub release — neither touches hex.pm's CDN,
# whose cert OTP 27 rejects (key_usage_mismatch).
RUN mix archive.install github hexpm/hex branch latest --force \
 && curl -fsSL -o /usr/local/bin/rebar3 https://github.com/erlang/rebar3/releases/latest/download/rebar3 \
 && chmod +x /usr/local/bin/rebar3 \
 && mix local.rebar rebar3 /usr/local/bin/rebar3 --force
