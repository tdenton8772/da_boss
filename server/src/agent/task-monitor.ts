import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { logger } from "../utils/logger.js";

interface TrackedTask {
  agentId: string;
  taskId: string;
  outputFile: string;
  startSize: number;
  startedAt: number;
}

/**
 * Centralized background task monitor.
 * Tracks output files from backgrounded shell commands across all agents.
 * Polls periodically and emits notifications when tasks complete.
 */
export class TaskMonitor {
  private tasks: TrackedTask[] = [];
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private eventBus: EventEmitter) {}

  /** Register a background task to monitor. */
  track(agentId: string, outputFile: string): void {
    if (this.tasks.find((t) => t.outputFile === outputFile)) return;

    const taskId = outputFile.replace(/[^a-zA-Z0-9]/g, "_").slice(-40);
    const startSize = existsSync(outputFile) ? statSync(outputFile).size : 0;

    this.tasks.push({
      agentId,
      taskId,
      outputFile,
      startSize,
      startedAt: Date.now(),
    });

    logger.info({ agentId, taskId, outputFile }, "Tracking background task");

    if (!this.pollInterval) {
      this.startPolling();
    }
  }

  /** Scan a Bash command string for output redirection + backgrounding. */
  detectFromCommand(agentId: string, command: string): void {
    // Match: > /path/to/file or >> /path/to/file, with & somewhere after
    const redirectMatch = command.match(/>+\s*(\/[^\s>&]+)/);
    const isBackgrounded = command.includes(" &") || command.endsWith("&");

    if (redirectMatch && isBackgrounded) {
      const outputFile = redirectMatch[1];
      this.track(agentId, outputFile);
    }
  }

  /** Scan any text content for file paths that might be task outputs. */
  detectFromContent(agentId: string, content: string): void {
    // SDK pattern: /path/to/tasks/TASKID.output
    for (const match of content.matchAll(/["']?(\/\S+?\/tasks\/(\w+)\.output)["']?/gi)) {
      this.track(agentId, match[1]);
    }
  }

  /** Remove all tasks for an agent (on kill). */
  removeAgent(agentId: string): void {
    this.tasks = this.tasks.filter((t) => t.agentId !== agentId);
    if (this.tasks.length === 0) this.stopPolling();
  }

  /** Stop monitoring. */
  shutdown(): void {
    this.stopPolling();
    this.tasks = [];
  }

  private startPolling(): void {
    this.pollInterval = setInterval(() => this.poll(), 2000);
  }

  private stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private poll(): void {
    const completed: TrackedTask[] = [];

    for (const task of this.tasks) {
      if (!existsSync(task.outputFile)) {
        // If file hasn't appeared after 30 seconds, give up
        if (Date.now() - task.startedAt > 30_000) {
          logger.warn({ taskId: task.taskId }, "Background task output file never appeared, dropping");
          completed.push(task);
        }
        continue;
      }

      try {
        const stat = statSync(task.outputFile);
        const fileAge = Date.now() - stat.mtimeMs;

        // File exists and hasn't been modified in 3+ seconds = likely done
        if (fileAge > 3000 && stat.size > task.startSize) {
          completed.push(task);
        }
      } catch {
        // File locked or inaccessible, skip
      }
    }

    for (const task of completed) {
      this.tasks = this.tasks.filter((t) => t !== task);

      let output = "";
      try {
        output = readFileSync(task.outputFile, "utf-8").trim();
        if (output.length > 2000) {
          output = "..." + output.slice(-2000);
        }
      } catch {
        output = "(could not read output)";
      }

      logger.info({ agentId: task.agentId, taskId: task.taskId, file: task.outputFile }, "Background task completed");

      const notification = [
        `<task-notification>`,
        `<task-id>${task.taskId}</task-id>`,
        `<output-file>${task.outputFile}</output-file>`,
        `<status>completed</status>`,
        `<summary>${output}</summary>`,
        `</task-notification>`,
      ].join("\n");

      this.eventBus.emit("agent:task-completed", {
        agentId: task.agentId,
        notification,
      });
    }

    if (this.tasks.length === 0) this.stopPolling();
  }
}
