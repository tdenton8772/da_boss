import { readFile, writeFile } from "node:fs/promises";
import { logger } from "./logger.js";

/**
 * Aggressively trim a session JSONL to fit within context limits.
 * Keeps the compaction summary (if present) + the last N messages.
 * Backs up the original file first.
 */
export async function trimSession(
  sessionPath: string,
  keepLastMessages = 10
): Promise<{ originalLines: number; trimmedLines: number }> {
  const raw = await readFile(sessionPath, "utf-8");
  const lines = raw.split("\n").filter((l: string) => l.trim());

  if (lines.length <= keepLastMessages + 5) {
    // Already small enough
    return { originalLines: lines.length, trimmedLines: lines.length };
  }

  const parsed = lines.map((l: string) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  });

  // Find compaction boundary messages (they mark where compaction summaries are)
  const compactIndices: number[] = [];
  parsed.forEach((msg: any, i: number) => {
    if (msg?.type === "compact_boundary" || msg?.type === "summary") {
      compactIndices.push(i);
    }
  });

  // Keep: first few lines (file-history-snapshot, system messages),
  //        last compaction summary if present,
  //        and the last N user/assistant messages
  const keep = new Set<number>();

  // Always keep the first line (usually file-history-snapshot)
  if (parsed[0]) keep.add(0);

  // Keep lines around the last compaction boundary
  if (compactIndices.length > 0) {
    const lastCompact = compactIndices[compactIndices.length - 1];
    // Keep the compact boundary and a few messages after it (the summary)
    for (let i = Math.max(0, lastCompact - 1); i <= Math.min(lines.length - 1, lastCompact + 3); i++) {
      keep.add(i);
    }
  }

  // Keep the last N messages (user + assistant)
  let kept = 0;
  for (let i = parsed.length - 1; i >= 0 && kept < keepLastMessages; i--) {
    const msg = parsed[i];
    if (msg && (msg.type === "user" || msg.type === "assistant" || msg.type === "result")) {
      keep.add(i);
      kept++;
    }
  }

  // Build trimmed content
  const trimmedLines = Array.from(keep)
    .sort((a, b) => a - b)
    .map((i) => lines[i]);

  // Backup original
  await writeFile(sessionPath + ".backup", raw);

  // Write trimmed version
  await writeFile(sessionPath, trimmedLines.join("\n") + "\n");

  logger.info(
    {
      sessionPath,
      originalLines: lines.length,
      trimmedLines: trimmedLines.length,
    },
    "Session trimmed"
  );

  return { originalLines: lines.length, trimmedLines: trimmedLines.length };
}
