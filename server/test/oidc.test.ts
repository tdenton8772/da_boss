import { describe, it, expect } from "vitest";
import { generateKeyPair, exportSPKI, SignJWT } from "jose";
import type { Request } from "express";
import { makeOidcProvider } from "../src/api/auth.js";
import * as queries from "../src/db/queries.js";

const CLAIMS = { subject: "sub", email: "email", name: "name", role: "role" };

async function keys() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  return { pem: await exportSPKI(publicKey), privateKey };
}

async function mint(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
  opts?: { iss?: string; aud?: string }
): Promise<string> {
  let b = new SignJWT(claims).setProtectedHeader({ alg: "RS256" }).setIssuedAt().setExpirationTime("1h");
  if (opts?.iss) b = b.setIssuer(opts.iss);
  if (opts?.aud) b = b.setAudience(opts.aud);
  return b.sign(privateKey);
}

const req = (token?: string) =>
  ({ headers: token ? { authorization: `Bearer ${token}` } : {} }) as unknown as Request;

describe("OidcAuthProvider", () => {
  it("verifies a valid RS256 token and provisions a user (keyed by sub)", async () => {
    const { pem, privateKey } = await keys();
    const provider = makeOidcProvider({ publicKey: pem, claims: CLAIMS });

    const token = await mint(privateKey, {
      sub: "okta|123",
      email: "dev@acme.com",
      name: "Dev",
      role: "developer",
    });
    const user = await provider.authenticate(req(token));
    expect(user?.email).toBe("dev@acme.com");
    expect(user?.name).toBe("Dev");

    const row = await queries.getUserByExternalId("okta|123");
    expect(row?.id).toBe(user!.userId);

    // a second call reuses the same user — no duplicate provisioning
    const again = await provider.authenticate(req(token));
    expect(again?.userId).toBe(user!.userId);
    expect(await queries.countUsers()).toBe(1);
  });

  it("rejects a token signed by a different key", async () => {
    const { pem } = await keys();
    const other = await keys();
    const provider = makeOidcProvider({ publicKey: pem, claims: CLAIMS });
    const token = await mint(other.privateKey, { sub: "x" });
    expect(await provider.authenticate(req(token))).toBeNull();
  });

  it("enforces issuer + audience when configured", async () => {
    const { pem, privateKey } = await keys();
    const provider = makeOidcProvider({
      publicKey: pem,
      issuer: "https://idp.example",
      audience: "daboss",
      claims: CLAIMS,
    });
    const good = await mint(privateKey, { sub: "u1" }, { iss: "https://idp.example", aud: "daboss" });
    expect(await provider.authenticate(req(good))).toBeTruthy();

    const wrongIss = await mint(privateKey, { sub: "u2" }, { iss: "https://evil", aud: "daboss" });
    expect(await provider.authenticate(req(wrongIss))).toBeNull();
  });

  it("returns null when no token is present", async () => {
    const { pem } = await keys();
    const provider = makeOidcProvider({ publicKey: pem, claims: CLAIMS });
    expect(await provider.authenticate(req())).toBeNull();
  });

  it("da_boss admin comes from adminEmails, NOT the IdP role", async () => {
    const { pem, privateKey } = await keys();
    const provider = makeOidcProvider({
      publicKey: pem, claims: CLAIMS,
      adminEmails: ["boss@x.io"], allowedRoles: ["write_all", "admin"],
    });

    // IdP role 'admin' but NOT in adminEmails → da_boss developer
    const notAdmin = await mint(privateKey, { sub: "okta|sa", email: "sa@x.io", role: "admin" });
    expect((await provider.authenticate(req(notAdmin)))?.role).toBe("developer");

    // In adminEmails → da_boss admin (even though IdP role is only write_all)
    const boss = await mint(privateKey, { sub: "okta|boss", email: "boss@x.io", role: "write_all" });
    expect((await provider.authenticate(req(boss)))?.role).toBe("admin");
    expect((await queries.getUserByExternalId("okta|boss"))?.role).toBe("admin");
  });

  it("denies identities not in an allowed group", async () => {
    const { pem, privateKey } = await keys();
    const provider = makeOidcProvider({
      publicKey: pem, claims: CLAIMS, allowedRoles: ["write_all", "admin"], adminEmails: [],
    });
    // read_own (not an allowed group) → denied, but provisioned as a PENDING row
    // (access_approved=false) so an admin can approve them with one toggle.
    const outsider = await mint(privateKey, { sub: "okta|out", email: "out@x.io", role: "read_own" });
    expect(await provider.authenticate(req(outsider))).toBeNull();
    expect((await queries.getUserByExternalId("okta|out"))?.access_approved).toBe(false);
    // write_all (SA) → allowed
    const sa = await mint(privateKey, { sub: "okta|sa2", email: "sa2@x.io", role: "write_all" });
    expect((await provider.authenticate(req(sa)))?.role).toBe("developer");
  });

  it("gates on the access_approved flag: role auto-grants it, and a manual grant overrides a non-qualifying role", async () => {
    const { pem, privateKey } = await keys();
    const provider = makeOidcProvider({
      publicKey: pem, claims: CLAIMS, allowedRoles: ["write_all"], adminEmails: [],
    });

    // SA role qualifies → allowed AND the flag is persisted (inspectable allowlist)
    const sa = await mint(privateKey, { sub: "okta|sa3", email: "sa3@x.io", role: "write_all" });
    expect(await provider.authenticate(req(sa))).not.toBeNull();
    expect((await queries.getUserByExternalId("okta|sa3"))?.access_approved).toBe(true);

    // A manager (role 'admin', no longer an allowed role) is denied by default,
    // but provisioned PENDING so an admin can flip access_approved to let them in.
    const mgr = await mint(privateKey, { sub: "okta|mgr", email: "mgr@x.io", role: "admin" });
    expect(await provider.authenticate(req(mgr))).toBeNull();
    expect((await queries.getUserByExternalId("okta|mgr"))?.access_approved).toBe(false);
    // one toggle later, they're in (the Paul flow — no DB surgery)
    await queries.setUserAccessApproved((await queries.getUserByExternalId("okta|mgr"))!.id, true);
    expect(await provider.authenticate(req(mgr))).not.toBeNull();

    // ...until an admin explicitly approves that user — then the flag lets them in
    // even though their role doesn't qualify.
    const guest = await queries.createUser({ id: "usr_guest1", email: "guest@x.io", role: "developer", external_id: "okta|guest" });
    await queries.setUserAccessApproved(guest.id, true);
    const guestTok = await mint(privateKey, { sub: "okta|guest", email: "guest@x.io", role: "read_own" });
    expect(await provider.authenticate(req(guestTok))).not.toBeNull();
  });

  it("boolean access claim is authoritative over the role (resolves multi-group users)", async () => {
    const { pem, privateKey } = await keys();
    const provider = makeOidcProvider({
      publicKey: pem,
      claims: { ...CLAIMS, access: "daboss_access" },
      allowedRoles: ["write_all"], adminEmails: [],
    });

    // Paul: manager role (would fail the role gate) but the IdP resolved his full
    // group list and stamped daboss_access=true → allowed.
    const paul = await mint(privateKey, { sub: "okta|paul", email: "paul@x.io", role: "admin", daboss_access: true });
    expect(await provider.authenticate(req(paul))).not.toBeNull();
    expect((await queries.getUserByExternalId("okta|paul"))?.access_approved).toBe(true);

    // Inverse: an allowed role but the claim says false → denied (claim wins).
    const sa = await mint(privateKey, { sub: "okta|sax", email: "sax@x.io", role: "write_all", daboss_access: false });
    expect(await provider.authenticate(req(sa))).toBeNull();
    expect((await queries.getUserByExternalId("okta|sax"))?.access_approved).toBe(false);
  });

  it("denies an offboarded identity and does not re-provision it", async () => {
    const { pem, privateKey } = await keys();
    const provider = makeOidcProvider({ publicKey: pem, claims: CLAIMS });

    await queries.recordOffboardedIdentity({ externalId: "okta|gone", email: "gone@x.io" });
    const token = await mint(privateKey, { sub: "okta|gone", email: "gone@x.io", role: "developer" });

    expect(await provider.authenticate(req(token))).toBeNull();
    expect(await queries.getUserByExternalId("okta|gone")).toBeUndefined();
  });
});
