declare module "node-cron" {
  export interface ScheduledTask {
    destroy(): void;
    stop(): void;
  }
  export function schedule(expression: string, task: () => void): ScheduledTask;
}