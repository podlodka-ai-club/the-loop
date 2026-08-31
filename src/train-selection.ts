import { drawSample, fingerprintOf, type Row, type Sample } from "./osv5m.ts";
import type { Manifest } from "./manifest.ts";

export type TrainingSelectionOptions = {
  limit: number;
  seed: string;
  matchManifest: boolean;
  metadataRows?: readonly Row[];
  onlyCountries?: ReadonlySet<string>;
};

export type TrainingSelection = {
  evalIds: Set<string>;
  evalSequences: Set<string>;
  evalRows: Row[];
  trainPool: Row[];
  sample: Sample;
  quotas: Map<string, number>;
  shortfalls: string[];
};

export function selectTrainingRows(
  availableRows: readonly Row[],
  manifest: Manifest,
  metadataRows: readonly Row[] = availableRows,
): {
  evalIds: Set<string>;
  evalSequences: Set<string>;
  evalRows: Row[];
  trainPool: Row[];
} {
  const evalIds = new Set(manifest.ids);
  const evalRows = metadataRows.filter((row) => evalIds.has(row.id));
  const evalSequences = new Set(evalRows.map((row) => row.sequence).filter((sequence) => sequence !== ""));
  const trainPool = availableRows.filter((row) => !evalIds.has(row.id) && !evalSequences.has(row.sequence));
  return { evalIds, evalSequences, evalRows, trainPool };
}

export function manifestQuotas(evalRows: readonly Row[], total: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of evalRows) {
    if (row.country === "") continue;
    counts.set(row.country, (counts.get(row.country) ?? 0) + 1);
  }
  const denominator = [...counts.values()].reduce((a, b) => a + b, 0);
  if (denominator === 0 || total <= 0) return new Map();

  const exact = [...counts.entries()].map(([country, count]) => ({
    country,
    share: (count / denominator) * total,
  }));
  const quotas = new Map<string, number>();
  for (const { country, share } of exact) quotas.set(country, Math.floor(share));

  let remaining = total - [...quotas.values()].reduce((a, b) => a + b, 0);
  const byRemainder = exact
    .map((entry) => ({ ...entry, fraction: entry.share - Math.floor(entry.share) }))
    .sort((a, b) => b.fraction - a.fraction || (a.country < b.country ? -1 : 1));
  for (const entry of byRemainder) {
    if (remaining <= 0) break;
    quotas.set(entry.country, (quotas.get(entry.country) ?? 0) + 1);
    remaining--;
  }
  return new Map([...quotas].filter(([, quota]) => quota > 0));
}

export function selectTrainingSample(
  pool: readonly Row[],
  manifest: Manifest,
  options: TrainingSelectionOptions,
): TrainingSelection {
  const selected = selectTrainingRows(pool, manifest, options.metadataRows);
  if (!options.matchManifest) {
    return {
      ...selected,
      sample: drawSample([...selected.trainPool], { size: options.limit, seed: options.seed }),
      quotas: new Map(),
      shortfalls: [],
    };
  }

  const allQuotas = manifestQuotas(selected.evalRows, options.limit);
  const onlyCountries = options.onlyCountries ?? new Set<string>();
  const quotas =
    onlyCountries.size === 0
      ? allQuotas
      : new Map([...allQuotas].filter(([country]) => onlyCountries.has(country)));
  const picked: Row[] = [];
  const shortfalls: string[] = [];
  for (const [country, quota] of [...quotas].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const byCountry = selected.trainPool.filter((row) => row.country === country);
    const drawn = drawSample(byCountry, { size: quota, seed: `${options.seed}:${country}` });
    picked.push(...drawn.rows);
    if (drawn.rows.length < quota) shortfalls.push(`${country} ${drawn.rows.length}/${quota}`);
  }
  picked.sort((a, b) => (a.id < b.id ? -1 : 1));
  return {
    ...selected,
    sample: {
      rows: picked,
      fingerprint: fingerprintOf(picked.map((row) => row.id)),
      seed: options.seed,
      strata: new Set(picked.map((row) => row.cell)).size,
    },
    quotas,
    shortfalls,
  };
}

export function assertSameSampleOrder(left: readonly Row[], right: readonly Row[]): void {
  if (left.length !== right.length) {
    throw new Error(`sample length mismatch: ${left.length} !== ${right.length}`);
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]?.id !== right[index]?.id) {
      throw new Error(`sample order mismatch at ${index}: ${left[index]?.id ?? "<missing>"} !== ${right[index]?.id ?? "<missing>"}`);
    }
  }
}
