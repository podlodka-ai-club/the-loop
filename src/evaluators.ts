/**
 * Phoenix evaluators for the OSV-5M protocol.
 *
 * One evaluator per metric on purpose: `resumeEvaluation` does not support
 * evaluators that emit several results, and one-per-metric keeps re-scoring cheap.
 */
import type { Evaluator } from "@arizeai/phoenix-client/types/experiments";
import { RADII_KM, geoScore, haversineKm } from "./geo.ts";
import type { LatLon } from "./geo.ts";
import type { TaskResult } from "./task.ts";

/** Ground truth carried on the dataset example's `output` field. */
export type Expected = {
  latitude: number;
  longitude: number;
  country: string;
};

type Scored = { distanceKm: number; prediction: LatLon; expected: Expected };

/**
 * Returns null when the item has no usable prediction, so distance-based means are
 * taken over valid items only. The failure rate is a separate metric.
 */
function score(output: unknown, expected: unknown): Scored | null {
  const result = output as TaskResult | null;
  if (!result?.ok) return null;
  const truth = expected as Expected | undefined;
  if (!truth || !Number.isFinite(truth.latitude) || !Number.isFinite(truth.longitude)) {
    return null;
  }
  return {
    distanceKm: haversineKm(result.guess, truth),
    prediction: result.guess,
    expected: truth,
  };
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

export const distanceKmEvaluator: Evaluator = {
  name: "distance_km",
  kind: "CODE",
  evaluate: ({ output, expected }) => {
    const scored = score(output, expected);
    if (!scored) {
      return { score: null, label: "no_prediction" };
    }
    return {
      score: scored.distanceKm,
      label: null,
      explanation: `${scored.distanceKm.toFixed(1)} km from ground truth`,
    };
  },
};

export const geoScoreEvaluator: Evaluator = {
  name: "geoscore",
  kind: "CODE",
  evaluate: ({ output, expected }) => {
    const scored = score(output, expected);
    // A failure earns 0, matching the all-items view of the run.
    return { score: scored ? geoScore(scored.distanceKm) : 0 };
  },
};

/** acc@1km, acc@25km, acc@200km, acc@750km, acc@2500km. Strict `<`, per the reference. */
const radiusEvaluators: Evaluator[] = RADII_KM.map((radiusKm) => ({
  name: `acc_${radiusKm}km`,
  kind: "CODE",
  evaluate: ({ output, expected }) => {
    const scored = score(output, expected);
    if (!scored) return { score: 0, label: "miss" };
    const hit = scored.distanceKm < radiusKm;
    return { score: hit ? 1 : 0, label: hit ? "hit" : "miss" };
  },
}));

export const validOutputEvaluator: Evaluator = {
  name: "valid_output",
  kind: "CODE",
  evaluate: ({ output }) => {
    const result = output as TaskResult | null;
    if (result?.ok) return { score: 1, label: "ok" };
    return {
      score: 0,
      label: result?.failure ?? "missing",
      explanation: result?.ok === false ? result.message : "task produced no output",
    };
  },
};

/**
 * Coordinates that parse but are not a real guess: exactly null island, or a
 * latitude that equals the longitude. Tracked separately because they score badly
 * for the wrong reason.
 */
export const degenerateEvaluator: Evaluator = {
  name: "degenerate_coords",
  kind: "CODE",
  evaluate: ({ output }) => {
    const result = output as TaskResult | null;
    if (!result?.ok) return { score: 0, label: "no_prediction" };
    const { latitude, longitude } = result.guess;
    const degenerate =
      (latitude === 0 && longitude === 0) || latitude === longitude;
    return { score: degenerate ? 1 : 0, label: degenerate ? "degenerate" : "ok" };
  },
};

/**
 * Flags a prediction that is too close to be inference.
 *
 * A vision model cannot derive a coordinate to four decimal places from pixels. When
 * it does, the label reached it another way: a burned-in dashcam telemetry overlay,
 * or memorised training data. OSV-5M has been public with exact coordinates since
 * April 2024, so both are live risks and this must be reported every run.
 */
export const suspectedLeakEvaluator: Evaluator = {
  name: "suspected_leak",
  kind: "CODE",
  evaluate: ({ output, expected }) => {
    const scored = score(output, expected);
    if (!scored) return { score: 0, label: "no_prediction" };
    const leak = scored.distanceKm < 0.5;
    return {
      score: leak ? 1 : 0,
      label: leak ? "suspected_leak" : "ok",
      explanation: leak
        ? `prediction is ${(scored.distanceKm * 1000).toFixed(0)} m from truth, which pixels cannot supply`
        : null,
    };
  },
};

/**
 * Soft signal only. This is NOT the official OSV-5M country accuracy, which
 * reverse-geocodes the predicted coordinate and ignores the model's prose. This
 * checks whether the `place` string names the true country, which is a different
 * and easier question.
 */
export const placeNamesCountryEvaluator: Evaluator = {
  name: "place_names_country",
  kind: "CODE",
  evaluate: ({ output, expected }) => {
    const result = output as TaskResult | null;
    const truth = expected as Expected | undefined;
    if (!result?.ok || !truth?.country) return { score: 0, label: "no_prediction" };
    const place = result.guess.place.toLowerCase();
    let name: string | undefined;
    try {
      name = regionNames.of(truth.country)?.toLowerCase();
    } catch {
      name = undefined;
    }
    const hit =
      place.includes(truth.country.toLowerCase()) ||
      (name !== undefined && name !== "" && place.includes(name));
    return { score: hit ? 1 : 0, label: hit ? "hit" : "miss" };
  },
};

/**
 * How much memory was actually in the prompt. Not a quality metric: it is the
 * evidence that ties a change in the numbers to the lessons rather than to noise.
 * A memory-on run that reports zero here did not test memory.
 */
export const hintCountEvaluator: Evaluator = {
  name: "hints_in_prompt",
  kind: "CODE",
  evaluate: ({ output }) => {
    const result = output as TaskResult | null;
    const count = result?.hintCount ?? 0;
    return {
      score: count,
      label: count > 0 ? "with_memory" : "no_memory",
      explanation: count > 0 ? (result?.hintIds ?? []).join(",") : null,
    };
  },
};

/** Rough prompt cost of those lessons, so context growth is visible as it happens. */
export const hintTokensEvaluator: Evaluator = {
  name: "hint_tokens",
  kind: "CODE",
  evaluate: ({ output }) => ({ score: (output as TaskResult | null)?.hintTokens ?? 0 }),
};

/** How many features the observation step produced. Zero means recall ran blind. */
export const featureCountEvaluator: Evaluator = {
  name: "features_observed",
  kind: "CODE",
  evaluate: ({ output }) => {
    const result = output as TaskResult | null;
    const count = result?.features?.length ?? 0;
    return { score: count, label: count > 0 ? "observed" : "blind" };
  },
};

export const geoEvaluators: Evaluator[] = [
  distanceKmEvaluator,
  geoScoreEvaluator,
  ...radiusEvaluators,
  validOutputEvaluator,
  degenerateEvaluator,
  placeNamesCountryEvaluator,
  suspectedLeakEvaluator,
  hintCountEvaluator,
  hintTokensEvaluator,
  featureCountEvaluator,
];
