import pg from "pg";
import { logger } from "../utils/logger.js";

/**
 * A dedicated LISTEN connection (a pooled one would get recycled) that
 * reconnects on failure. Every pod↔boss NOTIFY listener goes through here.
 *
 * Each attempt owns its own client. Whatever fails first — the 'error' event,
 * connect, LISTEN or `onConnect` — retires that client (handlers off, ended)
 * and schedules exactly one retry; a second report of the same failure, or a
 * late error from an already-retired client, is a no-op. So a flapping DB never
 * leaves a stale connection still LISTENing and double-handling notifications.
 */
export interface ListenOptions {
  /** For logs. */
  label: string;
  /** Fixed identifiers only — they're interpolated into LISTEN. */
  channels: string[];
  onNotification: (msg: pg.Notification) => void;
  /** Runs after LISTEN on every (re)connect: catch up on anything missed while
   *  disconnected. A throw retires the connection and retries. */
  onConnect?: () => Promise<void> | void;
  retryMs?: number;
  /** Test seam. */
  createClient?: () => pg.Client;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

/** Start listening; returns a stop fn that ends the connection and cancels any pending retry. */
export function listenWithReconnect(opts: ListenOptions): () => void {
  for (const ch of opts.channels) if (!IDENT.test(ch)) throw new Error(`Invalid LISTEN channel: ${ch}`);
  const retryMs = opts.retryMs ?? 2000;
  const createClient = opts.createClient ?? (() => new pg.Client({
    connectionString: process.env.DATABASE_URL || "postgres://daboss:daboss@localhost:5432/daboss", // same default as the pool
  }));
  let current: pg.Client | null = null;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const retire = (c: pg.Client) => {
    c.removeAllListeners();
    c.on("error", () => {}); // ending a broken socket can still emit 'error' — never let it crash the process
    c.end().catch(() => {});
  };

  const fail = (c: pg.Client, err: unknown) => {
    if (c !== current) return; // this attempt was already retired
    current = null;
    retire(c);
    if (closed) return;
    logger.warn({ listener: opts.label, err: err instanceof Error ? err.message : String(err) }, "LISTEN connection failed — reconnecting");
    timer = setTimeout(() => void connect(), retryMs);
  };

  const connect = async () => {
    timer = undefined;
    if (closed) return;
    const c = createClient();
    current = c;
    c.on("error", (err) => fail(c, err));
    c.on("notification", (msg) => { if (c === current) opts.onNotification(msg); });
    try {
      await c.connect();
      for (const ch of opts.channels) await c.query(`LISTEN ${ch}`);
      if (c !== current) return;
      await opts.onConnect?.();
      if (c === current) logger.info({ listener: opts.label, channels: opts.channels }, "LISTEN connection ready");
    } catch (err) {
      fail(c, err);
    }
  };

  void connect();
  return () => {
    closed = true;
    clearTimeout(timer);
    const c = current;
    current = null;
    if (c) retire(c);
  };
}
