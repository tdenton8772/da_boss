/**
 * T-shirt pod sizing. An agent's resource footprint is a named size; the caller
 * may specify one (fast path, no assessment) or the supervisor assesses the task
 * and picks one. Presets are the default map; a deployment can override the whole
 * table via DABOSS_SIZE_PRESETS (JSON) — nothing here is cluster-specific.
 */
export type TShirtSize = "s" | "m" | "l" | "xl";
export const SIZES: TShirtSize[] = ["s", "m", "l", "xl"];

export interface SizePreset {
  requests: { cpu: string; memory: string; "ephemeral-storage": string };
  limits: { memory: string; "ephemeral-storage": string };
}

const DEFAULT_PRESETS: Record<TShirtSize, SizePreset> = {
  s:  { requests: { cpu: "100m", memory: "256Mi", "ephemeral-storage": "1Gi" }, limits: { memory: "512Mi", "ephemeral-storage": "2Gi" } },
  m:  { requests: { cpu: "250m", memory: "512Mi", "ephemeral-storage": "2Gi" }, limits: { memory: "2Gi",   "ephemeral-storage": "4Gi" } },
  l:  { requests: { cpu: "500m", memory: "1Gi",   "ephemeral-storage": "4Gi" }, limits: { memory: "4Gi",   "ephemeral-storage": "8Gi" } },
  xl: { requests: { cpu: "1",    memory: "2Gi",   "ephemeral-storage": "8Gi" }, limits: { memory: "8Gi",   "ephemeral-storage": "16Gi" } },
};

/** The default size when none is specified and no assessment ran. */
export const DEFAULT_SIZE: TShirtSize = "m";

function loadPresets(): Record<TShirtSize, SizePreset> {
  const raw = process.env.DABOSS_SIZE_PRESETS;
  if (!raw) return DEFAULT_PRESETS;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<TShirtSize, SizePreset>>;
    return { ...DEFAULT_PRESETS, ...parsed };
  } catch {
    return DEFAULT_PRESETS; // bad override → safe default
  }
}

export function normalizeSize(size: string | null | undefined): TShirtSize | null {
  const s = size?.toLowerCase().trim();
  return s && (SIZES as string[]).includes(s) ? (s as TShirtSize) : null;
}

/** Resolve a size to its k8s resources, defaulting when unknown/absent. */
export function resolvePreset(size: string | null | undefined): SizePreset {
  return loadPresets()[normalizeSize(size) ?? DEFAULT_SIZE];
}

/** The next size up (for auto-bumping a task that died on resources). Caps at XL. */
export function nextSizeUp(size: string | null | undefined): TShirtSize {
  const i = SIZES.indexOf(normalizeSize(size) ?? DEFAULT_SIZE);
  return SIZES[Math.min(i + 1, SIZES.length - 1)];
}
