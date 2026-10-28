import { describe, it, expect } from "vitest";
import express from "express";
import session from "express-session";
import request from "supertest";
import { EventEmitter } from "node:events";
import { AgentManager } from "../src/agent/manager.js";
import { createRouter, uniqueName } from "../src/api/router.js";
import { attachmentNote, unannounced } from "../src/worker/uploads.js";

describe("attached files reach the agent", () => {
  it("the turn prompt names newly attached files — the agent is told, not just the UI", () => {
    const note = attachmentNote(["bug.png", "spec.pdf"]);
    expect(note).toContain("- /work/uploads/bug.png\n- /work/uploads/spec.pdf");
    expect(note).toMatch(/Read them/);
    expect(attachmentNote(["a.png"])).toMatch(/a file[\s\S]*Read it/);
    expect(attachmentNote([])).toBe("");
  });

  it("later turns only mention files the agent hasn't been told about", () => {
    const told = new Set(["a.png"]);
    expect(unannounced(["a.png", "b.png"], told)).toEqual(["b.png"]);
    expect(unannounced(["a.png"], told)).toEqual([]);
  });

  it("repeat names (every pasted screenshot is image.png) get a suffix instead of overwriting", () => {
    expect(uniqueName("image.png", new Set())).toBe("image.png");
    expect(uniqueName("image.png", new Set(["image.png"]))).toBe("image-2.png");
    expect(uniqueName("image.png", new Set(["image.png", "image-2.png"]))).toBe("image-3.png");
    expect(uniqueName("Makefile", new Set(["Makefile"]))).toBe("Makefile-2");
  });

  it("uploading through the real route stores the file, twice under distinct names", async () => {
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use(session({ secret: "s", resave: false, saveUninitialized: false }));
    app.use(createRouter(new AgentManager(new EventEmitter())));
    const a = request.agent(app);
    await a.post("/api/auth/register").send({ email: "u@t.co", password: "password123" }).expect(201);
    const ag = await a.post("/api/agents").send({ name: "x", prompt: "p", cwd: "/tmp" }).expect(201);
    const shot = Buffer.alloc(300_000, 7);
    const first = await a.post(`/api/agents/${ag.body.id}/files?name=image.png`).set("Content-Type", "image/png").send(shot).expect(201);
    const second = await a.post(`/api/agents/${ag.body.id}/files?name=image.png`).set("Content-Type", "image/png").send(shot).expect(201);
    expect([first.body.name, second.body.name]).toEqual(["image.png", "image-2.png"]);
    const list = await a.get(`/api/agents/${ag.body.id}/files`).expect(200);
    expect(list.body.map((f: { size: number }) => f.size)).toEqual([300_000, 300_000]);
  });
});
