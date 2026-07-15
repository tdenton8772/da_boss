import { describe, it, expect } from "vitest";
import { repoSlug, configKey, agentImageRef } from "../src/agent/agent-image.js";

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
