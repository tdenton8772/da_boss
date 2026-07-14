import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import session from "express-session";
import request from "supertest";
import { EventEmitter } from "node:events";
import { AgentManager } from "../src/agent/manager.js";
import { createRouter } from "../src/api/router.js";
import { setCipher, LocalAesCipher } from "../src/crypto/cipher.js";
import * as queries from "../src/db/queries.js";
import { generateToken, hashToken, tokenRouteAllowed } from "../src/api/tokens.js";

function createTestApp() {
  const manager = new AgentManager(new EventEmitter());
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "test-secret", resave: false, saveUninitialized: false }));
  app.use(createRouter(manager));
  return app;
}

let userSeq = 0;
async function sessionAgent(app: express.Express) {
  const agent = request.agent(app);
  userSeq++;
  await agent.post("/api/auth/register")
    .send({ email: `tok${userSeq}@test.co`, password: "password123", displayName: `T${userSeq}` })
    .expect(201);
  return agent;
}

describe("token primitives", () => {
  it("generates a dbt_ token whose hash is deterministic", () => {
    const { token, hash } = generateToken();
    expect(token.startsWith("dbt_")).toBe(true);
    expect(hash).toBe(hashToken(token));
    expect(hash).not.toContain(token); // stored hash never contains the secret
  });

  it("default-deny allow-list: right route+scope only", () => {
    expect(tokenRouteAllowed("POST", "/api/agents/ag_x/review", ["review:create"])).toBe(true);
    expect(tokenRouteAllowed("POST", "/api/agents/ag_x/review", ["review:read"])).toBe(false); // wrong scope
    expect(tokenRouteAllowed("GET", "/api/agents", ["review:read"])).toBe(true);
    expect(tokenRouteAllowed("POST", "/api/agents", ["agent:create"])).toBe(true);  // create with the scope
    expect(tokenRouteAllowed("POST", "/api/agents", ["review:create"])).toBe(false); // wrong scope
    expect(tokenRouteAllowed("POST", "/api/tokens", ["*"])).toBe(false);   // can't mint with a token
    expect(tokenRouteAllowed("POST", "/mcp", ["mcp"])).toBe(true);
    expect(tokenRouteAllowed("POST", "/mcp", ["review:create"])).toBe(false);
  });
});

describe("token queries", () => {
  it("round-trips create → lookup-by-hash → revoke", async () => {
    await queries.createUser({ id: "usr_t", email: "t@test.co" });
    const { hash } = generateToken();
    const row = await queries.createApiToken({ user_id: "usr_t", name: "bot", token_hash: hash, scopes: "review:read" });
    expect((await queries.getActiveApiTokenByHash(hash))!.id).toBe(row.id);
    expect(await queries.revokeApiToken(row.id, "usr_t")).toBe(true);
    expect(await queries.getActiveApiTokenByHash(hash)).toBeUndefined(); // revoked → inactive
  });

  it("listApiTokensForUser never returns the hash", async () => {
    await queries.createUser({ id: "usr_t", email: "t@test.co" });
    await queries.createApiToken({ user_id: "usr_t", name: "bot", token_hash: hashToken("dbt_x"), scopes: "" });
    const list = await queries.listApiTokensForUser("usr_t");
    expect(list).toHaveLength(1);
    expect((list[0] as Record<string, unknown>).token_hash).toBeUndefined();
  });

  it("can't revoke another user's token", async () => {
    await queries.createUser({ id: "usr_a", email: "a@test.co" });
    await queries.createUser({ id: "usr_b", email: "b@test.co" });
    const row = await queries.createApiToken({ user_id: "usr_a", token_hash: hashToken("dbt_y"), scopes: "" });
    expect(await queries.revokeApiToken(row.id, "usr_b")).toBe(false);
  });
});

describe("Bearer auth end-to-end", () => {
  let app: express.Express;
  beforeEach(() => { setCipher(new LocalAesCipher(Buffer.alloc(32, 7))); app = createTestApp(); });

  async function mintToken(scopes?: string[]) {
    const agent = await sessionAgent(app);
    const res = await agent.post("/api/tokens").send({ name: "test", scopes }).expect(201);
    return res.body.token as string;
  }

  it("a token reaches a token-allowed route (GET /api/agents)", async () => {
    const token = await mintToken(["review:read"]);
    await request(app).get("/api/agents").set("Authorization", `Bearer ${token}`).expect(200);
  });

  it("a token WITHOUT agent:create is denied on POST /api/agents → 403", async () => {
    const token = await mintToken(["review:read", "review:create"]);
    await request(app).post("/api/agents")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "x", prompt: "y", cwd: "/work" })
      .expect(403);
  });

  it("a token WITH agent:create can create an agent via REST", async () => {
    const token = await mintToken(["agent:create"]);
    const res = await request(app).post("/api/agents")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "x", prompt: "y", cwd: process.cwd() }); // host-mode cwd must exist
    expect(res.status).toBe(201);
  });

  it("a token CANNOT mint another token (POST /api/tokens) → 403", async () => {
    const token = await mintToken();
    await request(app).post("/api/tokens").set("Authorization", `Bearer ${token}`).send({ name: "z" }).expect(403);
  });

  it("a token missing the route's scope → 403", async () => {
    const token = await mintToken(["review:create"]); // no review:read
    await request(app).get("/api/agents").set("Authorization", `Bearer ${token}`).expect(403);
  });

  it("a revoked token falls through to no session → 401", async () => {
    const agent = await sessionAgent(app);
    const created = await agent.post("/api/tokens").send({ name: "temp", scopes: ["review:read"] }).expect(201);
    await agent.delete(`/api/tokens/${created.body.id}`).expect(200);
    await request(app).get("/api/agents").set("Authorization", `Bearer ${created.body.token}`).expect(401);
  });

  it("a bogus Bearer token → 401 (no session)", async () => {
    await request(app).get("/api/agents").set("Authorization", "Bearer dbt_notarealtoken").expect(401);
  });
});
