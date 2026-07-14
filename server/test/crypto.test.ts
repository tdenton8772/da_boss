import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { LocalAesCipher } from "../src/crypto/cipher.js";
import * as queries from "../src/db/queries.js";

describe("LocalAesCipher", () => {
  const cipher = new LocalAesCipher(randomBytes(32).toString("base64"));

  it("round-trips a secret", async () => {
    const secret = "test-secret-abc123";
    const blob = await cipher.encrypt(secret);
    expect(blob.ciphertext).not.toContain(secret);
    expect(blob.keyRef).toBe("local:v1");
    expect(await cipher.decrypt(blob)).toBe(secret);
  });

  it("uses a fresh nonce each time (ciphertext differs for same input)", async () => {
    const a = await cipher.encrypt("same");
    const b = await cipher.encrypt("same");
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it("rejects a tampered ciphertext (GCM auth tag)", async () => {
    const blob = await cipher.encrypt("secret");
    const buf = Buffer.from(blob.ciphertext, "base64");
    buf[0] ^= 0xff;
    await expect(
      cipher.decrypt({ ...blob, ciphertext: buf.toString("base64") })
    ).rejects.toThrow();
  });

  it("rejects a wrong-length key", () => {
    expect(() => new LocalAesCipher(randomBytes(16).toString("base64"))).toThrow();
  });
});

describe("credential vault (v5)", () => {
  it("stores encrypted, returns the blob (not plaintext), and upserts per user", async () => {
    const cipher = new LocalAesCipher(randomBytes(32).toString("base64"));
    const user = await queries.createUser({ id: "u_cred", email: "dev@acme.com" });

    const blob = await cipher.encrypt("test-secret-token");
    await queries.upsertUserCredential(user.id, "claude_oauth_token", blob);

    const stored = await queries.getUserCredential(user.id);
    expect(stored?.kind).toBe("claude_oauth_token");
    expect(stored?.ciphertext).toBe(blob.ciphertext);
    // the vault round-trips back to the original token via the cipher
    expect(
      await cipher.decrypt({ ciphertext: stored!.ciphertext, nonce: stored!.nonce, keyRef: stored!.key_ref })
    ).toBe("test-secret-token");

    // saving again replaces (one credential per user)
    const blob2 = await cipher.encrypt("newer-token");
    await queries.upsertUserCredential(user.id, "anthropic_api_key", blob2);
    const stored2 = await queries.getUserCredential(user.id);
    expect(stored2?.kind).toBe("anthropic_api_key");
  });

  it("looks a user up by email case-insensitively", async () => {
    await queries.createUser({ id: "u_x", email: "Mixed@Case.com" });
    const found = await queries.getUserByEmail("mixed@case.com");
    expect(found?.id).toBe("u_x");
  });
});
