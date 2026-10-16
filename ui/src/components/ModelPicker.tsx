import type { CatalogModel, ModelsInfo } from "../api";

/**
 * Model + effort selects driven by the server's discovered catalog (GET /api/models)
 * — nothing here names a model. Aliases ("opus" → newest Opus) are listed first
 * since they follow new releases; pinned ids follow.
 */

const SELECT = "w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-100 text-sm disabled:opacity-50";

/** An alias is a row whose value isn't the concrete model it runs (seed rows,
 *  which carry no resolvedModel, are aliases too). */
function isAlias(m: CatalogModel): boolean {
  return m.resolvedModel !== m.value;
}

function findEntry(info: ModelsInfo, model: string): CatalogModel | undefined {
  return info.models.find((m) => m.value === model) ?? info.models.find((m) => m.resolvedModel === model);
}

/** Effort levels a model accepts: its own list, else none for a live entry that
 *  reports no effort support, else the general ladder (unknown model / seed). */
export function effortLevelsFor(info: ModelsInfo, model: string | null): string[] {
  const entry = model ? findEntry(info, model) : undefined;
  if (entry?.supportedEffortLevels?.length) return entry.supportedEffortLevels;
  if (entry && info.source === "live" && !entry.supportsEffort) return [];
  return info.effort_levels;
}

export function ModelSelect({
  info, value, onChange, inheritLabel, className = SELECT,
}: {
  info: ModelsInfo;
  value: string | null;
  onChange: (model: string | null) => void;
  /** When set, offer an empty "inherit" choice with this label. */
  inheritLabel?: string;
  className?: string;
}) {
  const aliases = info.models.filter(isAlias);
  const pinned = info.models.filter((m) => !isAlias(m));
  const known = !value || info.models.some((m) => m.value === value);
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} className={className}>
      {inheritLabel && <option value="">{inheritLabel}</option>}
      {!known && <option value={value!}>{value}</option>}
      {aliases.length > 0 && (
        <optgroup label="Latest — follows new releases">
          {aliases.map((m) => (
            <option key={m.value} value={m.value} title={m.description}>
              {m.displayName}{m.resolvedModel ? ` (${m.value})` : ""}
            </option>
          ))}
        </optgroup>
      )}
      {pinned.length > 0 && (
        <optgroup label="Pinned versions">
          {pinned.map((m) => (
            <option key={m.value} value={m.value} title={m.description}>{m.displayName}</option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

export function EffortSelect({
  info, model, value, onChange, className = SELECT,
}: {
  info: ModelsInfo;
  model: string | null;
  value: string | null;
  onChange: (effort: string | null) => void;
  className?: string;
}) {
  const levels = effortLevelsFor(info, model);
  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      disabled={!levels.length}
      className={className}
    >
      <option value="">{levels.length ? "Model default" : "Not supported"}</option>
      {levels.map((l) => <option key={l} value={l}>{l}</option>)}
    </select>
  );
}
