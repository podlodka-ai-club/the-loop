/**
 * OSV-5M distance metrics.
 *
 * Ported from the reference implementation at
 * https://github.com/gastruc/osv5m `metrics/distance_based.py` and `metrics/utils.py`,
 * so numbers here are comparable with the paper (arXiv:2404.18873).
 */

/** Earth radius used by the reference implementation. */
const EARTH_RADIUS_KM = 6371;

/** GeoScore constant, from PIGEON (arXiv:2307.05845). */
const GEOSCORE_SCALE_KM = 1492.7;

/** Maximum GeoScore, awarded for a perfect prediction. */
const GEOSCORE_MAX = 5000;

/**
 * Accuracy radii in km, from `configs/config.yaml`.
 *
 * The same five thresholds are the IM2GPS3K / YFCC4K convention
 * (street, city, region, country, continent). The reference implementation
 * counts a hit with a strict `<`, not `<=`.
 */
export const RADII_KM = [1, 25, 200, 750, 2500] as const;

export type LatLon = { latitude: number; longitude: number };

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Great-circle distance in km. */
export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.latitude)) *
      Math.cos(toRadians(b.latitude)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Per-item GeoScore: `5000 * exp(-km / 1492.7)`, so 0 to 5000.
 *
 * The reported run score is the mean of per-item scores. `exp` is convex, so that
 * is not the same as scoring the mean distance. Never average the distance first.
 */
export function geoScore(distanceKm: number): number {
  return GEOSCORE_MAX * Math.exp(-distanceKm / GEOSCORE_SCALE_KM);
}
