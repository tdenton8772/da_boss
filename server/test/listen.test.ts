import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type pg from "pg";
import { listenWithReconnect } from "../src/db/listen.js";

/** A pg.Client stand-in: connect/LISTEN succeed unless told otherwise; tracks end(). */
class FakeClient extends EventEmitter {
  ended = false;
  listening: string[] = [];
  constructor(private failQuery?: Error) { super(); }
  async connect() {}
  async query(sql: string) {
    if (this.failQuery) throw this.failQuery;
    this.listening.push(sql);
  }
  async end() { this.ended = true; }
  notify(channel: string, payload?: string) { this.emit("notification", { processId: 1, channel, payload }); }
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("listenWithReconnect", () => {
  let clients: FakeClient[];
  let nextFails: (Error | undefined)[];
  const createClient = () => {
    const c = new FakeClient(nextFails.shift());
    clients.push(c);
    return c as unknown as pg.Client;
  };
  beforeEach(() => { vi.useFakeTimers(); clients = []; nextFails = []; });
  afterEach(() => vi.useRealTimers());

  it("a failed catch-up drain retires that connection — only the new one handles NOTIFY (issue #3)", async () => {
    const seen: string[] = [];
    let drains = 0;
    const stop = listenWithReconnect({
      label: "t", channels: ["daboss_agent_cmd"], createClient, retryMs: 2000,
      onNotification: (m) => seen.push(m.payload!),
      onConnect: async () => { if (++drains === 1) throw new Error("transient DB error"); },
    });
    await flush();
    expect(clients).toHaveLength(1);
    expect(clients[0].ended).toBe(true);
    expect(clients[0].listenerCount("notification")).toBe(0);

    await vi.advanceTimersByTimeAsync(2000);
    expect(clients).toHaveLength(2);
    expect(clients[1].ended).toBe(false);

    clients[0].notify("daboss_agent_cmd", "stale");
    clients[1].notify("daboss_agent_cmd", "live");
    expect(seen).toEqual(["live"]);

    stop();
    expect(clients[1].ended).toBe(true);
  });

  it("one failure reported twice (error event + rejected query) schedules one retry, not two", async () => {
    nextFails = [new Error("conn reset")];
    listenWithReconnect({ label: "t", channels: ["c"], createClient, retryMs: 2000, onNotification: () => {} });
    clients[0].emit("error", new Error("conn reset")); // fires alongside the rejected LISTEN
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(clients).toHaveLength(2);
    expect(clients.filter((c) => !c.ended)).toHaveLength(1);
  });

  it("a late error from a retired client never ends the live one", async () => {
    listenWithReconnect({ label: "t", channels: ["c"], createClient, retryMs: 2000, onNotification: () => {} });
    await flush();
    const first = clients[0];
    first.emit("error", new Error("drop"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(clients).toHaveLength(2);
    expect(() => first.emit("error", new Error("late"))).not.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(clients).toHaveLength(2);
    expect(clients[1].ended).toBe(false);
  });

  it("stop cancels a pending retry", async () => {
    nextFails = [new Error("down")];
    const stop = listenWithReconnect({ label: "t", channels: ["c"], createClient, retryMs: 2000, onNotification: () => {} });
    await flush();
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(clients).toHaveLength(1);
  });

  it("LISTENs on every channel and rejects non-identifier channel names", async () => {
    listenWithReconnect({ label: "t", channels: ["a_1", "b"], createClient, onNotification: () => {} });
    await flush();
    expect(clients[0].listening).toEqual(["LISTEN a_1", "LISTEN b"]);
    expect(() => listenWithReconnect({ label: "t", channels: ["x; DROP"], createClient, onNotification: () => {} })).toThrow(/Invalid LISTEN channel/);
  });
});
