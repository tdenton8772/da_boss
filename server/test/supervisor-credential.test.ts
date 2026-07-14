import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as queries from "../src/db/queries.js";
import { LocalAesCipher, setCipher } from "../src/crypto/cipher.js";
import {
  loadSupervisorCredentialIntoEnv,
  claudeCredentialPresent,
  SUPERVISOR_CRED_SETTING,
} from "../src/supervisor/credential.js";

// 32-byte key, base64
const KEY = Buffer.alloc(32, 7).toString("base64");

describe("supervisor credential", () => {
  beforeEach(() => {
    setCipher(new LocalAesCipher(KEY));
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.SUPERVISOR_CREDENTIAL_USER;
  });
  afterEach(() => setCipher(null));

  async function designate(userId: string, kind: string, token: string) {
    await queries.createUser({ id: userId, email: `${userId}@x.io` });
    const blob = await new LocalAesCipher(KEY).encrypt(token);
    await queries.upsertUserCredential(userId, kind, blob);
    await queries.setAppSetting(SUPERVISOR_CRED_SETTING, userId);
  }

  it("loads the designated user's token into the SDK env", async () => {
    await designate("usr_sup", "anthropic_api_key", "test-cred-secret");
    const status = await loadSupervisorCredentialIntoEnv();
    expect(status.ok).toBe(true);
    expect(status.userId).toBe("usr_sup");
    expect(process.env.ANTHROPIC_API_KEY).toBe("test-cred-secret");
    expect(claudeCredentialPresent()).toBe(true);
  });

  it("maps oauth kind to the oauth env var", async () => {
    await designate("usr_o", "claude_oauth_token", "oauth-tok");
    await loadSupervisorCredentialIntoEnv();
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-tok");
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("degrades (no throw) and clears env when unset", async () => {
    process.env.ANTHROPIC_API_KEY = "stale";
    const status = await loadSupervisorCredentialIntoEnv();
    expect(status.ok).toBe(false);
    expect(status.reason).toMatch(/no supervisor credential/i);
    expect(claudeCredentialPresent()).toBe(false); // stale token cleared
  });

  it("degrades when the designated user was offboarded (credential gone)", async () => {
    await queries.setAppSetting(SUPERVISOR_CRED_SETTING, "usr_gone");
    const status = await loadSupervisorCredentialIntoEnv();
    expect(status.ok).toBe(false);
    expect(status.reason).toMatch(/no Claude credential/i);
    expect(claudeCredentialPresent()).toBe(false);
  });
});
