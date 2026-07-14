/**
 * SecretCipher — provider-neutral seam for encrypting per-user credentials at
 * rest. The core stores only `{ciphertext, nonce, keyRef}` and never sees the
 * backend. `keyRef` names which key/provider sealed the blob, so switching
 * backends (local → GCP KMS → AWS KMS → Vault) is a config change + re-wrap job,
 * never a schema change.
 *
 * No PGP/asymmetric here on purpose: the boss decrypts online at dispatch to
 * inject the token, so any private key would live with the service anyway —
 * symmetric authenticated encryption (AES-256-GCM) is the right primitive.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface EncryptedBlob {
  ciphertext: string; // base64(ciphertext || 16-byte GCM tag)
  nonce: string; // base64(12-byte IV)
  keyRef: string; // e.g. "local:v1", "gcp-kms://…", "aws-kms://…"
}

export interface SecretCipher {
  encrypt(plaintext: string): Promise<EncryptedBlob>;
  decrypt(blob: EncryptedBlob): Promise<string>;
}

/** AES-256-GCM with a key held locally (from a k8s Secret / env). Default
 *  reference implementation — works anywhere, zero external dependencies. */
export class LocalAesCipher implements SecretCipher {
  static readonly KEY_REF = "local:v1";
  private readonly key: Buffer;

  constructor(keyBase64: string) {
    this.key = Buffer.from(keyBase64, "base64");
    if (this.key.length !== 32) {
      throw new Error("DABOSS_CIPHER_KEY must decode to 32 bytes (base64-encoded 256-bit key)");
    }
  }

  async encrypt(plaintext: string): Promise<EncryptedBlob> {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      ciphertext: Buffer.concat([enc, tag]).toString("base64"),
      nonce: nonce.toString("base64"),
      keyRef: LocalAesCipher.KEY_REF,
    };
  }

  async decrypt(blob: EncryptedBlob): Promise<string> {
    const buf = Buffer.from(blob.ciphertext, "base64");
    if (buf.length < 17) throw new Error("ciphertext too short");
    const tag = buf.subarray(buf.length - 16);
    const enc = buf.subarray(0, buf.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(blob.nonce, "base64"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  }
}

let cipher: SecretCipher | null = null;

/** The configured cipher. `CRYPTO_PROVIDER` selects the backend (only `local`
 *  implemented so far; kms/vault adapters slot in here behind the same seam). */
export function getCipher(): SecretCipher {
  if (!cipher) {
    const provider = process.env.CRYPTO_PROVIDER || "local";
    if (provider === "local") {
      const key = process.env.DABOSS_CIPHER_KEY;
      if (!key) throw new Error("DABOSS_CIPHER_KEY env var is required for the local crypto provider");
      cipher = new LocalAesCipher(key);
    } else {
      throw new Error(`Unsupported CRYPTO_PROVIDER '${provider}' (implemented: local)`);
    }
  }
  return cipher;
}

/** Test hook to inject a cipher. */
export function setCipher(c: SecretCipher | null): void {
  cipher = c;
}
