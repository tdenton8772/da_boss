import { EventEmitter } from "node:events";
import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import type { ServerEvent, ClientCommand } from "../types/events.js";
import { logger } from "../utils/logger.js";

interface Client {
  ws: WebSocket;
  subscriptions: Set<string>;
  alive: boolean;
}

export function setupWebSocket(
  server: Server,
  eventBus: EventEmitter
): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });
  const clients = new Set<Client>();

  // Ping all clients every 30s to keep connections alive
  const pingInterval = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.ws.terminate();
        clients.delete(client);
        continue;
      }
      client.alive = false;
      client.ws.ping();
    }
  }, 30_000);

  wss.on("close", () => clearInterval(pingInterval));

  wss.on("connection", (ws) => {
    const client: Client = { ws, subscriptions: new Set(), alive: true };
    clients.add(client);
    logger.info("WebSocket client connected");

    ws.on("pong", () => {
      client.alive = true;
    });

    ws.on("message", (raw) => {
      try {
        const cmd = JSON.parse(raw.toString()) as ClientCommand;
        if (cmd.type === "subscribe") {
          client.subscriptions.add(cmd.agentId);
        } else if (cmd.type === "unsubscribe") {
          client.subscriptions.delete(cmd.agentId);
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.on("close", () => {
      clients.delete(client);
      logger.info("WebSocket client disconnected");
    });

    ws.on("error", () => {
      clients.delete(client);
    });
  });

  // Forward all server events to subscribed clients
  eventBus.on("server-event", (event: ServerEvent) => {
    const agentId = "agentId" in event ? event.agentId : null;
    const payload = JSON.stringify(event);

    // Debug logging
    if (event.type === "agent:message") {
      logger.info({ event, clientCount: clients.size }, "Broadcasting agent:message event");
    }

    for (const client of clients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;

      // Agent-specific events only go to subscribers of that agent
      if ((event.type === "agent:stream" || event.type === "agent:message") && agentId) {
        if (client.subscriptions.has(agentId)) {
          logger.info({ agentId, eventType: event.type }, "Sending event to subscribed client");
          client.ws.send(payload);
        }
        continue;
      }

      // All other events go to everyone (state changes, permissions, budget)
      client.ws.send(payload);
    }
  });

  return wss;
}
