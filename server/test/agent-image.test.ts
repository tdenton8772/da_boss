import { describe, it, expect, vi, afterEach } from "vitest";
import { repoSlug, configKey, agentImageRef, hashIncludePaths } from "../src/agent/agent-image.js";

const BASE = "us-central1-docker.pkg.dev/proj/daboss/da-boss:sometag";

describe("repoSlug", () => {
  it("makes an org-repo slug from a git URL", () => {
    expect(repoSlug("https://github.com/scylladb/Odyssey.git")).toBe("scylladb-odyssey");
    expect(repoSlug("git@github.com:acme/My_Repo.git")).toBe("acme-my-repo");
  });
});

describe("configKey — content-addressed, base-aware", () => {
  it("is stable for the same base + Dockerfile", () => {
    expect(configKey(BASE, "FROM x\nRUN y")).toBe(configKey(BASE, "FROM x\nRUN y"));
  });
  it("changes when the repo's Dockerfile changes (rebuild on new deps)", () => {
    expect(configKey(BASE, "RUN pip install fastembed")).not.toBe(configKey(BASE, "RUN pip install fastembed torch"));
  });
  it("changes when the da_boss base changes (rebuild → never stale worker code)", () => {
    expect(configKey(BASE, "RUN y")).not.toBe(configKey(BASE.replace("sometag", "newtag"), "RUN y"));
  });
});

describe("agentImageRef", () => {
  it("puts the agent image in the base's registry/project, tagged by the config key", () => {
    const ref = agentImageRef(BASE, "https://github.com/scylladb/Odyssey.git", "FROM ${DABOSS_BASE}\nRUN pip install fastembed");
    expect(ref).toMatch(/^us-central1-docker\.pkg\.dev\/proj\/daboss\/agent-scylladb-odyssey:[0-9a-f]{16}$/);
  });
  it("same repo, different declaration → different tag (rebuilds once)", () => {
    const a = agentImageRef(BASE, "https://github.com/o/r.git", "RUN a");
    const b = agentImageRef(BASE, "https://github.com/o/r.git", "RUN b");
    expect(a).not.toBe(b);
    expect(a.split(":")[0]).toBe(b.split(":")[0]); // same repository, different tag
  });
});

describe("hashIncludePaths", () => {
  it("parses a single directive line into paths", () => {
    const df = "FROM x\n# daboss-hash-include: web/mix.lock workers/pyproject.toml\nRUN y";
    expect(hashIncludePaths(df)).toEqual(["web/mix.lock", "workers/pyproject.toml"]);
  });
  it("merges multiple directive lines and dedups", () => {
    const df = "# daboss-hash-include: a b\nFROM x\n#daboss-hash-include: b c";
    expect(hashIncludePaths(df)).toEqual(["a", "b", "c"]);
  });
  it("returns empty for a Dockerfile without the directive", () => {
    expect(hashIncludePaths("FROM x\nRUN y")).toEqual([]);
  });
  it("changing an included file's content changes the image tag", () => {
    const df = "FROM ${DABOSS_BASE}\n# daboss-hash-include: web/mix.lock";
    const a = agentImageRef(BASE, "https://github.com/o/r.git", df + "\n--- web/mix.lock ---\nlock-v1");
    const b = agentImageRef(BASE, "https://github.com/o/r.git", df + "\n--- web/mix.lock ---\nlock-v2");
    expect(a).not.toBe(b);
  });
});

describe("resolveAgentImage — split layout (toolchain image + mounted /app)", () => {
  const OS_A = "us-central1-docker.pkg.dev/proj/daboss/da-boss-os:deployA";
  const OS_B = "us-central1-docker.pkg.dev/proj/daboss/da-boss-os:deployB";
  const DF = "ARG DABOSS_BASE\nFROM ${DABOSS_BASE}\nRUN apt-get install -y python3";

  async function load(layers: Record<string, string | null>, dockerfile: string | null = DF) {
    vi.resetModules();
    const built: Array<{ image: string; buildArgs?: Record<string, string> }> = [];
    vi.doMock("../src/forge/github.js", () => ({ getFileContents: async () => dockerfile }));
    vi.doMock("../src/agent/image-builder.js", () => ({
      imageLayersKey: async (ref: string) => layers[ref] ?? null,
      ensureImage: async (image: string, spec: { buildArgs?: Record<string, string> }) => { built.push({ image, buildArgs: spec.buildArgs }); },
    }));
    const mod = await import("../src/agent/agent-image.js");
    const resolve = (toolchainBase?: string) =>
      mod.resolveAgentImage({ repoUrl: "https://github.com/o/r.git", gitToken: "t", baseImage: BASE, toolchainBase });
    return { resolve, built };
  }
  afterEach(() => { vi.doUnmock("../src/forge/github.js"); vi.doUnmock("../src/agent/image-builder.js"); vi.resetModules(); });

  it("a da_boss deploy with unchanged OS layers reuses the same toolchain image", async () => {
    const { resolve, built } = await load({ [OS_A]: "layers1", [OS_B]: "layers1" });
    const a = await resolve(OS_A);
    const b = await resolve(OS_B);
    expect(a).toEqual({ image: b.image, mountApp: true });
    expect(a.image).toMatch(/\/agent-o-r:[0-9a-f]{16}$/);
    expect(built[0].buildArgs).toEqual({ DABOSS_BASE: OS_A }); // built FROM the OS base, not the worker
  });

  it("changed OS layers produce a new toolchain image", async () => {
    const { resolve } = await load({ [OS_A]: "layers1", [OS_B]: "layers2" });
    expect((await resolve(OS_A)).image).not.toBe((await resolve(OS_B)).image);
  });

  it("unreadable layers fall back to keying on the ref (rebuild — the safe direction)", async () => {
    const { resolve } = await load({});
    expect((await resolve(OS_A)).image).not.toBe((await resolve(OS_B)).image);
  });

  it("without a toolchain base, keeps the combined layout (no mount, keyed on the worker image)", async () => {
    const { resolve, built } = await load({});
    const r = await resolve(undefined);
    expect(r.mountApp).toBe(false);
    expect(built[0].buildArgs).toEqual({ DABOSS_BASE: BASE });
  });

  it("a repo without an agent Dockerfile runs in the worker image", async () => {
    const { resolve, built } = await load({ [OS_A]: "layers1" }, null);
    expect(await resolve(OS_A)).toEqual({ image: BASE, mountApp: false });
    expect(built).toHaveLength(0);
  });
});
