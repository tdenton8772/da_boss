import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import session from "express-session";
import request from "supertest";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { AgentManager } from "../src/agent/manager.js";
import { createRouter } from "../src/api/router.js";
import { setCipher, LocalAesCipher } from "../src/crypto/cipher.js";

function createTestApp() {
  const eventBus = new EventEmitter();
  const manager = new AgentManager(eventBus);
  const app = express();

  app.use(express.json());
  app.use(
    session({
      secret: "test-secret",
      resave: false,
      saveUninitialized: false,
    })
  );
  app.use(createRouter(manager));

  return { app, manager, eventBus };
}

// Helper to get an authenticated agent (registers a fresh per-user account).
// DB is reset per test, so a unique email per call avoids collisions.
let userSeq = 0;
async function authAgent(app: express.Express) {
  const agent = request.agent(app);
  userSeq++;
  await agent
    .post("/api/auth/register")
    .send({ email: `user${userSeq}@test.co`, password: "password123", displayName: `User ${userSeq}` })
    .expect(201);
  return agent;
}

describe("API routes", () => {
  let app: express.Express;
  let manager: AgentManager;

  beforeEach(() => {
    const testApp = createTestApp();
    app = testApp.app;
    manager = testApp.manager;
  });

  describe("auth", () => {
    it("rejects unauthenticated requests", async () => {
      await request(app).get("/api/agents").expect(401);
    });

    it("registers a user and logs in with email+password", async () => {
      const agent = request.agent(app);
      const reg = await agent
        .post("/api/auth/register")
        .send({ email: "a@b.co", password: "password123", displayName: "A" })
        .expect(201);
      expect(reg.body.user.email).toBe("a@b.co");

      await agent.post("/api/auth/logout").expect(200);
      const login = await agent
        .post("/api/auth/login")
        .send({ email: "a@b.co", password: "password123" })
        .expect(200);
      expect(login.body.user.email).toBe("a@b.co");
    });

    it("rejects wrong password", async () => {
      const agent = request.agent(app);
      await agent
        .post("/api/auth/register")
        .send({ email: "c@d.co", password: "password123" })
        .expect(201);
      await request(app)
        .post("/api/auth/login")
        .send({ email: "c@d.co", password: "wrong" })
        .expect(401);
    });

    it("allows authenticated requests", async () => {
      const agent = await authAgent(app);
      const res = await agent.get("/api/agents").expect(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("reports auth status + user via /me", async () => {
      const unauthed = await request(app).get("/api/auth/me").expect(200);
      expect(unauthed.body.authenticated).toBe(false);

      const agent = await authAgent(app);
      const authed = await agent.get("/api/auth/me").expect(200);
      expect(authed.body.authenticated).toBe(true);
      expect(authed.body.user).toBeTruthy();
    });
  });

  describe("credentials (write-only vault)", () => {
    beforeEach(() => setCipher(new LocalAesCipher(randomBytes(32).toString("base64"))));

    it("stores a credential and reports status without leaking the token", async () => {
      const agent = await authAgent(app);
      const before = await agent.get("/api/me/credential").expect(200);
      expect(before.body.hasCredential).toBe(false);

      const token = "test-oauth-token-value";
      await agent
        .post("/api/me/credential")
        .send({ kind: "claude_oauth_token", token })
        .expect(200);

      const after = await agent.get("/api/me/credential").expect(200);
      expect(after.body.hasCredential).toBe(true);
      expect(after.body.kind).toBe("claude_oauth_token");
      // the token itself is never returned
      expect(JSON.stringify(after.body)).not.toContain(token);

      await agent.delete("/api/me/credential").expect(200);
      const gone = await agent.get("/api/me/credential").expect(200);
      expect(gone.body.hasCredential).toBe(false);
    });

    it("rejects a too-short token", async () => {
      const agent = await authAgent(app);
      await agent.post("/api/me/credential").send({ token: "x" }).expect(400);
    });
  });

  describe("agents CRUD", () => {
    it("creates an agent", async () => {
      const agent = await authAgent(app);
      const res = await agent
        .post("/api/agents")
        .send({
          name: "test-agent",
          prompt: "Do a thing",
          cwd: "/tmp",
          priority: "high",
        })
        .expect(201);

      expect(res.body.id).toMatch(/^ag_/);
      expect(res.body.name).toBe("test-agent");
      expect(res.body.state).toBe("pending");
      expect(res.body.priority).toBe("high");
    });

    it("validates required fields", async () => {
      const agent = await authAgent(app);
      await agent
        .post("/api/agents")
        .send({ name: "no-prompt" })
        .expect(400);
    });

    it("lists agents with token summaries", async () => {
      const agent = await authAgent(app);

      await agent
        .post("/api/agents")
        .send({ name: "a1", prompt: "test", cwd: "/tmp" })
        .expect(201);
      await agent
        .post("/api/agents")
        .send({ name: "a2", prompt: "test", cwd: "/tmp" })
        .expect(201);

      const res = await agent.get("/api/agents").expect(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].tokens).toBeDefined();
      expect(res.body[0].tokens.total_cost_usd).toBe(0);
    });

    it("gets a single agent", async () => {
      const agent = await authAgent(app);
      const created = await agent
        .post("/api/agents")
        .send({ name: "single", prompt: "test", cwd: "/tmp" })
        .expect(201);

      const res = await agent
        .get(`/api/agents/${created.body.id}`)
        .expect(200);
      expect(res.body.name).toBe("single");
      expect(res.body.total_cost_usd).toBe(0);
    });

    it("returns 404 for non-existent agent", async () => {
      const agent = await authAgent(app);
      await agent.get("/api/agents/ag_nope").expect(404);
    });
  });

  describe("agent events", () => {
    it("returns empty events for new agent", async () => {
      const agent = await authAgent(app);
      const created = await agent
        .post("/api/agents")
        .send({ name: "evt", prompt: "test", cwd: "/tmp" })
        .expect(201);

      const res = await agent
        .get(`/api/agents/${created.body.id}/events`)
        .expect(200);
      // Will have at least 1 event (state_change from creation)
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe("permissions", () => {
    it("returns empty pending permissions", async () => {
      const agent = await authAgent(app);
      const res = await agent.get("/api/permissions/pending").expect(200);
      expect(res.body).toEqual([]);
    });

    it("validates resolve request", async () => {
      const agent = await authAgent(app);
      await agent
        .post("/api/permissions/999/resolve")
        .send({ decision: "approved" })
        .expect(404);
    });

    it("rejects invalid decision values", async () => {
      const agent = await authAgent(app);
      await agent
        .post("/api/permissions/1/resolve")
        .send({ decision: "maybe" })
        .expect(400);
    });
  });

  describe("budget", () => {
    it("returns default budget", async () => {
      const agent = await authAgent(app);
      const res = await agent.get("/api/budget").expect(200);
      expect(res.body.config.daily_budget_usd).toBe(10.0);
      expect(res.body.config.monthly_budget_usd).toBe(200.0);
      expect(res.body.daily_spend_usd).toBe(0);
      expect(res.body.daily_percent).toBe(0);
    });

    it("updates budget config", async () => {
      const agent = await authAgent(app);
      const res = await agent
        .put("/api/budget")
        .send({ daily_budget_usd: 25.0, monthly_budget_usd: 500.0 })
        .expect(200);

      expect(res.body.config.daily_budget_usd).toBe(25.0);
      expect(res.body.config.monthly_budget_usd).toBe(500.0);
    });

    it("validates budget update params", async () => {
      const agent = await authAgent(app);
      await agent
        .put("/api/budget")
        .send({ daily_budget_usd: "not a number" })
        .expect(400);
    });
  });

  describe("agent lifecycle (without SDK)", () => {
    it("kills a pending agent", async () => {
      const agent = await authAgent(app);
      const created = await agent
        .post("/api/agents")
        .send({ name: "killme", prompt: "test", cwd: "/tmp" })
        .expect(201);

      await agent
        .post(`/api/agents/${created.body.id}/kill`)
        .expect(200);

      const fetched = await agent
        .get(`/api/agents/${created.body.id}`)
        .expect(200);
      expect(fetched.body.state).toBe("aborted");
    });
  });
});
