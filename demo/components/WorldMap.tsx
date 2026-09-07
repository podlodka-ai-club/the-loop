"use client";

import { useEffect, useState } from "react";

type Ring = [number, number][];
type Geometry = { type: string; coordinates: unknown };
type World = { features: { geometry: Geometry }[] };

const W = 1000;
const H = 500;

/**
 * Equirectangular, because the demo compares two dots and a line between them.
 * A projection with less area distortion would need a library and would not make
 * "the answer moved to another continent" any more legible than this does.
 */
const x = (lon: number): number => ((lon + 180) / 360) * W;
const y = (lat: number): number => ((90 - lat) / 180) * H;

function ringPath(ring: Ring): string {
  return `${ring.map(([lon, lat], i) => `${i === 0 ? "M" : "L"}${x(lon).toFixed(1)} ${y(lat).toFixed(1)}`).join("")}Z`;
}

function toPath(geometry: Geometry): string {
  if (geometry.type === "Polygon") return (geometry.coordinates as Ring[]).map(ringPath).join("");
  if (geometry.type === "MultiPolygon")
    return (geometry.coordinates as Ring[][]).map((poly) => poly.map(ringPath).join("")).join("");
  return "";
}

export type Marker = { lat: number; lon: number; label: string; kind: "truth" | "guess" };

export function WorldMap({ markers }: { markers: Marker[] }) {
  const [paths, setPaths] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    fetch("world.geo.json")
      .then((response) => response.json() as Promise<World>)
      .then((world) => {
        if (live) setPaths(world.features.map((f) => toPath(f.geometry)).filter(Boolean));
      })
      .catch(() => setPaths([]));
    return () => {
      live = false;
    };
  }, []);

  const truth = markers.find((m) => m.kind === "truth");
  const guess = markers.find((m) => m.kind === "guess");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="map" role="img" aria-label="карта">
      <rect width={W} height={H} fill="#0d1117" />
      {[-60, -30, 0, 30, 60].map((lat) => (
        <line key={lat} x1={0} x2={W} y1={y(lat)} y2={y(lat)} stroke="#1b232e" strokeWidth={1} />
      ))}
      {[-120, -60, 0, 60, 120].map((lon) => (
        <line key={lon} y1={0} y2={H} x1={x(lon)} x2={x(lon)} stroke="#1b232e" strokeWidth={1} />
      ))}
      {paths.map((d, i) => (
        <path key={i} d={d} fill="#1e2733" stroke="#2f3d4d" strokeWidth={0.7} />
      ))}

      {truth && guess && (
        <line
          x1={x(truth.lon)}
          y1={y(truth.lat)}
          x2={x(guess.lon)}
          y2={y(guess.lat)}
          stroke="#e0603a"
          strokeWidth={2}
          strokeDasharray="6 5"
        />
      )}

      {truth && (
        <g>
          <circle cx={x(truth.lon)} cy={y(truth.lat)} r={11} fill="none" stroke="#4ade80" strokeWidth={3} />
          <circle cx={x(truth.lon)} cy={y(truth.lat)} r={4} fill="#4ade80" />
        </g>
      )}
      {guess && (
        <g>
          <circle cx={x(guess.lon)} cy={y(guess.lat)} r={7} fill="#e0603a" />
          <circle cx={x(guess.lon)} cy={y(guess.lat)} r={13} fill="none" stroke="#e0603a" strokeWidth={2} opacity={0.5} />
        </g>
      )}
    </svg>
  );
}
