/**
 * Models selectable for agents — the last few versions of each family, so a user
 * whose Claude credential lacks the newest model (per-org/plan access) can pick an
 * older one instead of failing at runtime with a model 404.
 * Keep in sync with the UI dropdown (CreateAgentForm.tsx).
 * IDs from https://platform.claude.com/docs/en/about-claude/models/overview —
 * dateless IDs are pinned snapshots (4.6+); older families use dated IDs.
 */
export const SUPPORTED_MODELS = [
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-fable-5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5-20251001",
] as const;

export const DEFAULT_MODEL = "claude-opus-5";
