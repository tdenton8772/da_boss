import { Router } from "express";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";
import { createReadStream } from "node:fs";
import { nanoid } from "nanoid";
import * as queries from "../db/queries.js";
import { logger } from "../utils/logger.js";

// ── Types ────────────────────────────────────────────────

interface ProjectInfo {
  projectKey: string;
  realPath: string;
  sessionCount: number;
  latestSessionId: string | null;
  latestModified: string | null;
}

interface SessionInfo {
  sessionId: string;
  modified: string;
  sizeBytes: number;
  firstPrompt: string | null;
  messageCount: number;
  isLocked: boolean;
}

interface MessageInfo {
  type: "user" | "assistant";
  content: string;
  timestamp: string | null;
}

// ── Helpers ──────────────────────────────────────────────

function getProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/**
 * Extract text content from a message content field.
 * Content can be a string or an array of content blocks.
 */
function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      if (block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      } else if (block.type === "tool_use") {
        const toolName = block.name || "unknown";
        const inputSummary = summarizeToolInput(toolName, block.input);
        parts.push(`[Tool: ${toolName}${inputSummary}]`);
      } else if (block.type === "tool_result") {
        parts.push(`[Tool Result]`);
      }
    }
  }
  return parts.join("\n");
}

/**
 * Produce a short summary of tool input for display.
 */
function summarizeToolInput(toolName: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;

  // Common patterns for well-known tools
  if (toolName === "Read" && typeof obj.file_path === "string") {
    return ` ${obj.file_path}`;
  }
  if (toolName === "Write" && typeof obj.file_path === "string") {
    return ` ${obj.file_path}`;
  }
  if (toolName === "Edit" && typeof obj.file_path === "string") {
    return ` ${obj.file_path}`;
  }
  if (toolName === "Bash" && typeof obj.command === "string") {
    const cmd = obj.command.length > 60 ? obj.command.slice(0, 60) + "..." : obj.command;
    return ` \`${cmd}\``;
  }
  if (toolName === "Glob" && typeof obj.pattern === "string") {
    return ` ${obj.pattern}`;
  }
  if (toolName === "Grep" && typeof obj.pattern === "string") {
    return ` ${obj.pattern}`;
  }
  if (toolName === "Agent" && typeof obj.prompt === "string") {
    const prompt = obj.prompt.length > 60 ? obj.prompt.slice(0, 60) + "..." : obj.prompt;
    return ` "${prompt}"`;
  }

  return "";
}

/**
 * Read the first N lines from a JSONL file using streams.
 * Avoids loading entire multi-MB files into memory.
 */
async function readFirstLines(filePath: string, maxLines: number): Promise<string[]> {
  const lines: string[] = [];
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (line.trim()) {
        lines.push(line);
      }
      if (lines.length >= maxLines) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return lines;
}

/**
 * Read the last N lines from a JSONL file.
 * Reads the file in chunks from the end to avoid loading it all into memory.
 */
async function readLastLines(filePath: string, maxLines: number): Promise<string[]> {
  const stat = await fs.stat(filePath);
  const fileSize = Number(stat.size);

  if (fileSize === 0) return [];

  // For small files, just read the whole thing
  if (fileSize < 1024 * 1024) {
    const content = await fs.readFile(filePath, "utf-8");
    const allLines = content.split("\n").filter((l) => l.trim());
    return allLines.slice(-maxLines);
  }

  // For large files, read from the end in chunks
  const chunkSize = Math.min(512 * 1024, fileSize); // 512KB chunks
  const lines: string[] = [];
  let position = fileSize;
  let remainder = "";

  const handle = await fs.open(filePath, "r");
  try {
    while (position > 0 && lines.length < maxLines) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;
      const buffer = Buffer.alloc(readSize);
      await handle.read(buffer, 0, readSize, position);
      const chunk = buffer.toString("utf-8") + remainder;
      const chunkLines = chunk.split("\n");
      remainder = chunkLines[0]; // The first segment might be partial

      // Add lines from end (skip first which might be partial)
      for (let i = chunkLines.length - 1; i >= 1; i--) {
        if (chunkLines[i].trim()) {
          lines.unshift(chunkLines[i]);
        }
        if (lines.length >= maxLines) break;
      }
    }

    // Don't forget the remainder if we've reached the start of the file
    if (position === 0 && remainder.trim() && lines.length < maxLines) {
      lines.unshift(remainder);
    }
  } finally {
    await handle.close();
  }

  return lines.slice(-maxLines);
}

/**
 * Try to extract the cwd from the first user message in a session JSONL.
 */
async function extractCwdFromSession(sessionPath: string): Promise<string | null> {
  try {
    const lines = await readFirstLines(sessionPath, 20);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.cwd && typeof parsed.cwd === "string") {
          return parsed.cwd;
        }
      } catch {
        // skip unparseable lines
      }
    }
  } catch {
    // file might not be readable
  }
  return null;
}

/**
 * Extract the first user prompt from a session.
 */
async function extractFirstPrompt(sessionPath: string): Promise<string | null> {
  try {
    const lines = await readFirstLines(sessionPath, 20);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "user" && parsed.message?.content) {
          const text = extractTextContent(parsed.message.content);
          // Truncate long prompts
          return text.length > 200 ? text.slice(0, 200) + "..." : text;
        }
      } catch {
        // skip
      }
    }
  } catch {
    // file not readable
  }
  return null;
}

/**
 * Count user + assistant messages in a session.
 * For efficiency, streams through the file counting type fields
 * rather than fully parsing each line.
 */
async function countMessages(sessionPath: string): Promise<number> {
  let count = 0;
  const stream = createReadStream(sessionPath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      // Quick check before parsing: look for "type":"user" or "type":"assistant"
      if (line.includes('"type":"user"') || line.includes('"type":"assistant"')) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === "user" || parsed.type === "assistant") {
            count++;
          }
        } catch {
          // skip
        }
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return count;
}

// ── Router ───────────────────────────────────────────────

export function createDiscoveryRouter(): Router {
  const router = Router();

  // ── GET /api/discover/projects ─────────────────────────
  router.get("/api/discover/projects", async (_req, res) => {
    try {
      const projectsDir = getProjectsDir();

      let entries: string[];
      try {
        entries = await fs.readdir(projectsDir);
      } catch {
        res.json([]);
        return;
      }

      const projects: ProjectInfo[] = [];

      for (const entry of entries) {
        const entryPath = path.join(projectsDir, entry);
        try {
          const stat = await fs.stat(entryPath);
          if (!stat.isDirectory()) continue;
        } catch {
          continue;
        }

        // Find .jsonl session files
        let files: string[];
        try {
          files = await fs.readdir(entryPath);
        } catch {
          continue;
        }

        const sessionFiles = files.filter((f) => f.endsWith(".jsonl"));
        if (sessionFiles.length === 0) continue;

        // Find the most recently modified session
        let latestSessionId: string | null = null;
        let latestModified: Date | null = null;

        for (const sf of sessionFiles) {
          try {
            const sfStat = await fs.stat(path.join(entryPath, sf));
            if (!latestModified || sfStat.mtime > latestModified) {
              latestModified = sfStat.mtime;
              latestSessionId = sf.replace(".jsonl", "");
            }
          } catch {
            continue;
          }
        }

        // Try to get the real path from the latest session's cwd
        let realPath: string | null = null;
        if (latestSessionId) {
          realPath = await extractCwdFromSession(
            path.join(entryPath, latestSessionId + ".jsonl")
          );
        }

        // Fallback: reconstruct from the directory name
        if (!realPath) {
          realPath = entry.replace(/^-/, "/").replace(/-/g, "/");
        }

        projects.push({
          projectKey: entry,
          realPath,
          sessionCount: sessionFiles.length,
          latestSessionId,
          latestModified: latestModified ? latestModified.toISOString() : null,
        });
      }

      // Sort by latest modified descending
      projects.sort((a, b) => {
        if (!a.latestModified && !b.latestModified) return 0;
        if (!a.latestModified) return 1;
        if (!b.latestModified) return -1;
        return b.latestModified.localeCompare(a.latestModified);
      });

      res.json(projects);
    } catch (err) {
      logger.error({ err }, "Failed to discover projects");
      res.status(500).json({ error: "Failed to discover projects" });
    }
  });

  // ── GET /api/discover/projects/:projectKey/sessions ────
  router.get("/api/discover/projects/:projectKey/sessions", async (req, res) => {
    try {
      const projectDir = path.join(getProjectsDir(), req.params.projectKey);

      let files: string[];
      try {
        files = await fs.readdir(projectDir);
      } catch {
        res.status(404).json({ error: "Project not found" });
        return;
      }

      const sessionFiles = files.filter((f) => f.endsWith(".jsonl"));

      // Get stats for all sessions and sort by modification time
      const sessionStats: Array<{
        name: string;
        stat: Awaited<ReturnType<typeof fs.stat>>;
      }> = [];

      for (const sf of sessionFiles) {
        try {
          const sfStat = await fs.stat(path.join(projectDir, sf));
          sessionStats.push({ name: sf, stat: sfStat });
        } catch {
          continue;
        }
      }

      sessionStats.sort((a, b) => Number(b.stat.mtimeMs) - Number(a.stat.mtimeMs));

      // Limit to 10 most recent
      const topSessions = sessionStats.slice(0, 10);

      // Check for lock indicators: a directory with the same UUID name
      const dirEntries = new Set(
        files.filter((f) => !f.endsWith(".jsonl") && f !== "memory")
      );

      const sessions: SessionInfo[] = [];
      const now = Date.now();

      for (const { name, stat } of topSessions) {
        const sessionId = name.replace(".jsonl", "");
        const sessionPath = path.join(projectDir, name);

        // Determine if locked: UUID directory exists or modified in last 60s
        const hasLockDir = dirEntries.has(sessionId);
        const recentlyModified = now - Number(stat.mtimeMs) < 60_000;
        const isLocked = hasLockDir || recentlyModified;

        // Extract first prompt
        const firstPrompt = await extractFirstPrompt(sessionPath);

        // Count messages
        const messageCount = await countMessages(sessionPath);

        sessions.push({
          sessionId,
          modified: stat.mtime.toISOString(),
          sizeBytes: Number(stat.size),
          firstPrompt,
          messageCount,
          isLocked,
        });
      }

      res.json(sessions);
    } catch (err) {
      logger.error({ err }, "Failed to list sessions");
      res.status(500).json({ error: "Failed to list sessions" });
    }
  });

  // ── GET /api/discover/projects/:projectKey/sessions/:sessionId/messages ──
  router.get(
    "/api/discover/projects/:projectKey/sessions/:sessionId/messages",
    async (req, res) => {
      try {
        const limit = Math.min(
          parseInt(req.query.limit as string) || 50,
          500
        );
        const sessionPath = path.join(
          getProjectsDir(),
          req.params.projectKey,
          req.params.sessionId + ".jsonl"
        );

        try {
          await fs.access(sessionPath);
        } catch {
          res.status(404).json({ error: "Session not found" });
          return;
        }

        // Read enough lines from the end to get `limit` user/assistant messages.
        // We read more raw lines since many lines are progress/tool_use/etc.
        const rawLines = await readLastLines(sessionPath, limit * 5);

        const messages: MessageInfo[] = [];

        for (const line of rawLines) {
          try {
            const parsed = JSON.parse(line);

            if (parsed.type === "user" && parsed.message?.content) {
              messages.push({
                type: "user",
                content: extractTextContent(parsed.message.content),
                timestamp: parsed.timestamp || null,
              });
            } else if (parsed.type === "assistant" && parsed.message?.content) {
              const text = extractTextContent(parsed.message.content);
              // Skip assistant messages that are only thinking blocks (no visible content)
              if (text.trim()) {
                messages.push({
                  type: "assistant",
                  content: text,
                  timestamp: parsed.timestamp || null,
                });
              }
            }
            // Skip type: "progress", "file-history-snapshot", etc.
          } catch {
            // skip unparseable lines
          }
        }

        // Return only the last `limit` messages
        res.json(messages.slice(-limit));
      } catch (err) {
        logger.error({ err }, "Failed to read session messages");
        res.status(500).json({ error: "Failed to read session messages" });
      }
    }
  );

  // ── POST /api/discover/import ──────────────────────────
  router.post("/api/discover/import", async (req, res) => {
    try {
      const { projectKey, sessionId, name, priority } = req.body as {
        projectKey?: string;
        sessionId?: string;
        name?: string;
        priority?: "high" | "medium" | "low";
      };

      if (!projectKey || !sessionId || !name) {
        res.status(400).json({
          error: "projectKey, sessionId, and name are required",
        });
        return;
      }

      const sessionPath = path.join(
        getProjectsDir(),
        projectKey,
        sessionId + ".jsonl"
      );

      try {
        await fs.access(sessionPath);
      } catch {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      // Extract the first user prompt and cwd from the session
      const firstPrompt = await extractFirstPrompt(sessionPath);
      const cwd = await extractCwdFromSession(sessionPath);

      if (!cwd) {
        res.status(400).json({
          error: "Could not determine working directory from session",
        });
        return;
      }

      const agentId = nanoid();

      const agent = queries.insertAgent({
        id: agentId,
        name,
        prompt: firstPrompt || "(imported session - no prompt found)",
        cwd,
        state: "paused",
        priority: priority || "medium",
        permission_mode: "default",
        sdk_session_id: sessionId,
        model: "claude-sonnet-4-20250514",
        max_turns: null,
        max_budget_usd: null,
        error_message: "Imported from existing session - resume when ready",
        supervisor_instructions: "",
        permission_policy: "auto",
      });

      logger.info(
        { agentId, sessionId, projectKey },
        "Imported discovered session as agent"
      );

      res.status(201).json(agent);
    } catch (err) {
      logger.error({ err }, "Failed to import session");
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  return router;
}
