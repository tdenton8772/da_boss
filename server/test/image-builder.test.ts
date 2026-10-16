import { describe, it, expect, vi } from "vitest";
import { parseImageRef, cacheRepoFor, imagesToEnsure, pickPlatformManifest, layersKey, imageLayersKey } from "../src/agent/image-builder.js";

// Pure logic behind on-demand image builds: which images a phase needs built, how
// their refs split, and where kaniko's layer cache lives.

describe("parseImageRef", () => {
  it("splits a full registry ref with a tag", () => {
    expect(parseImageRef("us-central1-docker.pkg.dev/proj/daboss/elixir-test:1.18")).toEqual({
      registry: "us-central1-docker.pkg.dev",
      repository: "proj/daboss/elixir-test",
      tag: "1.18",
    });
  });

  it("defaults the tag to latest", () => {
    expect(parseImageRef("us-central1-docker.pkg.dev/proj/daboss/x").tag).toBe("latest");
  });

  it("treats a Docker Hub ref (no registry host) as having no registry", () => {
    const r = parseImageRef("python:3.12-slim");
    expect(r.registry).toBe("");
    expect(r.tag).toBe("3.12-slim");
  });
});

describe("cacheRepoFor", () => {
  it("puts the kaniko cache alongside the image under /cache", () => {
    expect(cacheRepoFor("us-central1-docker.pkg.dev/proj/daboss/elixir-test:1.18"))
      .toBe("us-central1-docker.pkg.dev/proj/daboss/cache");
  });
  it("is empty for a registryless ref (never built)", () => {
    expect(cacheRepoFor("python:3.12")).toBe("");
  });
});

describe("imagesToEnsure", () => {
  it("includes the phase image only when it declares a build", () => {
    expect(imagesToEnsure({ image: "reg/a:1" })).toEqual([]); // no build → assume it exists
    expect(imagesToEnsure({ image: "reg/a:1", build: { context: "images/a" } }))
      .toEqual([{ image: "reg/a:1", build: { context: "images/a" } }]);
  });

  it("includes service images that declare a build", () => {
    const out = imagesToEnsure({
      image: "reg/elixir:1", build: { context: "images/elixir" },
      services: [
        { image: "reg/pg:17", build: { context: "images/pg" } },
        { image: "docker.io/redis:7" }, // no build → skip (public/prebuilt)
      ],
    });
    expect(out.map((x) => x.image)).toEqual(["reg/elixir:1", "reg/pg:17"]);
  });

  it("returns nothing when no image/build is declared", () => {
    expect(imagesToEnsure({ command: "npm test" } as never)).toEqual([]);
  });
});

describe("image identity by layers", () => {
  it("picks linux/amd64 from an index and skips buildx attestations", () => {
    const entries = [
      { digest: "sha256:att", platform: { os: "unknown", architecture: "unknown" }, annotations: { "vnd.docker.reference.type": "attestation-manifest" } },
      { digest: "sha256:arm", platform: { os: "linux", architecture: "arm64" } },
      { digest: "sha256:amd", platform: { os: "linux", architecture: "amd64" } },
    ];
    expect(pickPlatformManifest(entries)?.digest).toBe("sha256:amd");
    expect(pickPlatformManifest(entries.slice(0, 2))?.digest).toBe("sha256:arm");
    expect(pickPlatformManifest(entries.slice(0, 1))).toBeUndefined();
  });

  it("keys on layer digests only", () => {
    expect(layersKey(["sha256:a", "sha256:b"])).toBe(layersKey(["sha256:a", "sha256:b"]));
    expect(layersKey(["sha256:a", "sha256:b"])).not.toBe(layersKey(["sha256:a", "sha256:c"]));
  });

  it("reads layers through an image index, and returns null when it can't", async () => {
    const calls: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("metadata.google.internal")) throw new Error("off-GCP");
      if (u.endsWith("/manifests/t1")) return new Response(JSON.stringify({ manifests: [{ digest: "sha256:img", platform: { os: "linux", architecture: "amd64" } }] }));
      if (u.endsWith("/manifests/sha256%3Aimg")) return new Response(JSON.stringify({ layers: [{ digest: "sha256:l1" }, { digest: "sha256:l2" }] }));
      return new Response("", { status: 404 });
    });
    try {
      expect(await imageLayersKey("us-central1-docker.pkg.dev/p/r/os:t1")).toBe(layersKey(["sha256:l1", "sha256:l2"]));
      expect(await imageLayersKey("us-central1-docker.pkg.dev/p/r/os:missing")).toBeNull();
      expect(await imageLayersKey("python:3.12")).toBeNull(); // no registry → never fetched
    } finally {
      fetchMock.mockRestore();
    }
  });
});
