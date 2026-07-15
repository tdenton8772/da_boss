import { describe, it, expect } from "vitest";
import { parseImageRef, cacheRepoFor, imagesToEnsure } from "../src/agent/image-builder.js";

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
