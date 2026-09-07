"use client";

import { useEffect, useMemo, useState } from "react";
import { WorldMap } from "@/components/WorldMap";
import {
  MODES,
  VOLUMES,
  formatKm,
  orderFrames,
  resolveRun,
  type ModeId,
  type Showcase,
} from "@/lib/showcase";

export default function Page() {
  const [data, setData] = useState<Showcase | null>(null);
  const [frameIndex, setFrameIndex] = useState(0);
  const [mode, setMode] = useState<ModeId>("baseline");
  const [volume, setVolume] = useState(73);

  useEffect(() => {
    fetch("showcase.json")
      .then((response) => response.json() as Promise<Showcase>)
      .then(setData)
      .catch(() => setData(null));
  }, []);

  const frames = useMemo(() => (data ? orderFrames(data.frames) : []), [data]);

  if (!data || frames.length === 0) {
    return (
      <main className="page">
        <h1>Загрузка…</h1>
      </main>
    );
  }

  const frame = frames[Math.min(frameIndex, frames.length - 1)]!;
  const runKey = resolveRun(mode, volume);
  const result = frame.modes[runKey];
  const baseline = frame.modes["baseline"];
  const lessons = result?.snapshot ? (data.lessons[result.snapshot] ?? {}) : {};

  const markers = [
    { lat: frame.truth.lat, lon: frame.truth.lon, label: "истина", kind: "truth" as const },
    ...(result?.predicted.lat != null && result.predicted.lon != null
      ? [{ lat: result.predicted.lat, lon: result.predicted.lon, label: "ответ", kind: "guess" as const }]
      : []),
  ];

  // The delta against no-memory is the whole claim of the demo, so it is stated on
  // every mode rather than left for the viewer to subtract.
  const delta =
    result?.errorKm != null && baseline?.errorKm != null && runKey !== "baseline"
      ? result.errorKm - baseline.errorKm
      : null;

  const place = [frame.truth.city, frame.truth.region, frame.truth.country]
    .filter((part) => part && part !== "")
    .join(", ");

  return (
    <main className="page">
      <div className="top">
        <h1>Loci — что память делает с ответом</h1>
        <span className="meta">
          {data.model} · {data.corpus} · витрина {frames.length} кадров
        </span>
      </div>

      <div className="grid">
        <section className="panel frame">
          <img src={frame.image} alt={place} />
          <div className="truth">
            <span className="dot truth-dot" />
            <span className="place">{place}</span>
            <span className="coords">
              {frame.truth.lat.toFixed(3)}, {frame.truth.lon.toFixed(3)}
            </span>
          </div>
          <div className="strip">
            {frames.map((item, index) => (
              <button
                key={item.id}
                data-active={index === frameIndex}
                onClick={() => setFrameIndex(index)}
                title={[item.truth.city, item.truth.country].filter(Boolean).join(", ")}
              >
                <img src={item.image} alt="" />
              </button>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="modes">
            {MODES.map((option) => (
              <button
                key={option.id}
                data-active={option.id === mode}
                onClick={() => setMode(option.id)}
              >
                <strong>{option.title}</strong>
                {option.sub}
              </button>
            ))}
          </div>

          <div className="volume" data-disabled={mode !== "threshold2"}>
            <label htmlFor="volume">Объём памяти</label>
            <input
              id="volume"
              type="range"
              min={0}
              max={VOLUMES.length - 1}
              step={1}
              disabled={mode !== "threshold2"}
              value={VOLUMES.findIndex((v) => v.lessons === volume)}
              onChange={(event) => setVolume(VOLUMES[Number(event.target.value)]!.lessons)}
            />
            <span className="value">
              {mode === "threshold2" ? `${volume} уроков` : "только в «Порог 2»"}
            </span>
          </div>

          <div style={{ marginTop: 16 }}>
            <WorldMap markers={markers} />
          </div>

          <div className="readout">
            <span
              className="error"
              data-bad={result?.errorKm != null && result.errorKm > 1000}
              data-good={result?.errorKm != null && result.errorKm < 200}
            >
              {formatKm(result?.errorKm ?? null)}
            </span>
            <span className="guessed">
              <span className="dot guess-dot" /> {result?.predicted.place ?? "нет ответа"}
            </span>
            {delta != null && (
              <span className="delta">
                {delta >= 0 ? "+" : "−"}
                {formatKm(Math.abs(delta))} к ответу без памяти
              </span>
            )}
          </div>

          <div className="hints">
            {!result || result.hintCount === 0 ? (
              <p className="empty">
                {runKey === "baseline"
                  ? "Уроков в промпте нет — это исходный промпт агента."
                  : "Ни один урок не прошёл порог. Промпт совпадает с прогоном без памяти."}
              </p>
            ) : (
              <>
                {result.hintIds.slice(0, 6).map((id) => {
                  const lesson = lessons[id];
                  if (!lesson) return null;
                  return (
                    <div className="hint" key={id}>
                      <div className="region">{lesson.region}</div>
                      <div className="text">{lesson.text}</div>
                      <div className="triggers">
                        {lesson.triggers.map((trigger) => (
                          <span key={trigger}>{trigger}</span>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {result.hintCount > 6 && (
                  <p className="more">…и ещё {result.hintCount - 6} уроков в том же промпте</p>
                )}
              </>
            )}
          </div>
        </section>
      </div>

      <section className="panel summary">
        <h2>Полные прогоны</h2>
        <table>
          <thead>
            <tr>
              <th>Режим</th>
              <th>Кадров</th>
              <th>Медиана</th>
              <th>GeoScore</th>
              <th>Притяжение</th>
              <th>С подсказками</th>
            </tr>
          </thead>
          <tbody>
            {data.summary.map((row) => (
              <tr key={row.key} data-active={row.key === runKey}>
                <td>
                  {row.label}
                  {row.scope === "25" && <span className="scope"> · только витрина</span>}
                </td>
                <td>{row.frames}</td>
                <td>{formatKm(row.medianKm)}</td>
                <td>{Math.round(row.geoscore)}</td>
                <td>{Math.round(row.attraction * 100)}%</td>
                <td>{row.hintedFrames}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="note">
          Числа посчитаны по полным прогонам корпуса — 863 кадра или замороженный
          префикс в 430, — а не по 25 кадрам витрины. Две строки, помеченные «только
          витрина», прогнаны на этих 25 кадрах: полного прогона на снапшотах в 25 и 48
          уроков не делали. Притяжение — доля предсказаний, попавших в один из 61
          региона, названного уроками; без памяти это 5%, то есть случайный уровень.
        </p>
      </section>
    </main>
  );
}
