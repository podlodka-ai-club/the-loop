/**
 * The learning loop: run the agent over a training stream, and after every attempt
 * ask it to write down what it should have noticed.
 *
 * Usage:
 *   node src/train.ts [--limit 0] [--snapshot-every 10] [--two-step]
 *
 * The training stream is the frozen train corpus, not a draw made here. Holding the
 * two corpora apart is a property of the corpora, so it is decided once at freeze
 * time and recorded in the manifests: the train corpus shares no id, no `sequence`,
 * no uploader and no 25 km grid cell with the eval corpus. Drawing here instead
 * would re-derive that separation on every run, from whatever shards this machine
 * happens to hold.
 *
 * This replaced a run-time draw that copied country quotas off the eval manifest. The
 * requirement behind those quotas still holds and is now met earlier: a lesson about a
 * country the benchmark never shows cannot move the number, it only adds tokens, which
 * is exactly what the shuffled control is meant to isolate. `src/split.ts` gives the two
 * corpora matching country shares at freeze time, and `npm run sample` prints the gap
 * next to the smallest gap the pool allows, so the property is checked rather than
 * re-approximated per run.
 */
import { provider } from "./agent.ts";
import { DEFAULT_TRAIN_MANIFEST, loadFrozenSample } from "./manifest.ts";
import { haversineKm } from "./geo.ts";
import { RECALL_LIMIT } from "./memory/memory.ts";
import { FileMemory, parseRecallMode } from "./memory/file/memory.ts";
import { loadLabels } from "./osv5m.ts";
import { reflect } from "./reflect.ts";
import { runTask } from "./task.ts";
import type { ExampleInput } from "./task.ts";

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

// 0 means the whole corpus. A smaller number takes a prefix, which is a shorter run
// over the same frozen items, not a different draw.
const limit = Number(flag("limit", "0"));
const snapshotEvery = Number(flag("snapshot-every", "10"));
const recallMode = parseRecallMode(flag("recall", "all"));
const twoStep = process.argv.includes("--two-step");

const { rows: pool } = await loadLabels();
const corpus = await loadFrozenSample(pool, flag("manifest", DEFAULT_TRAIN_MANIFEST), "train");

/**
 * Aim the stream at the countries the benchmark will actually score.
 *
 * The frozen corpora already match country for country, which is what makes a lesson
 * scoreable at all. Aiming narrows that further: the eval corpus is 147 countries with
 * a long tail, and training uniformly across it spends most of the run on countries
 * that appear once.
 *
 * Countries, not regions, even though a lesson names a region. The eval corpus holds
 * 512 regions across 863 frames - 1.7 frames per region - so a per-region split of the
 * result would compare groups of one. Country is the smallest unit that yields groups
 * worth reading. What a lesson says and how the result is grouped are different
 * questions: the lesson stays regional because that is where the error lives, and the
 * report groups by country because that is where the sample size lives.
 */
const countriesFrom = flag("countries-from", "");
let rows = corpus.rows;
let targetCountries = new Set<string>();

if (countriesFrom !== "") {
  const evalHead = Number(flag("eval-head", "0"));
  const countryCount = Number(flag("countries", "15"));
  const perCountry = Number(flag("per-country", "5"));

  const evalCorpus = await loadFrozenSample(pool, countriesFrom, "eval");
  const evalRows = evalHead > 0 ? evalCorpus.rows.slice(0, evalHead) : evalCorpus.rows;

  const frequency = new Map<string, number>();
  for (const row of evalRows) {
    if (row.country.trim() === "") continue;
    frequency.set(row.country, (frequency.get(row.country) ?? 0) + 1);
  }
  const ranked = [...frequency.entries()]
    .sort(([a, ca], [b, cb]) => cb - ca || (a < b ? -1 : 1))
    .slice(0, countryCount);
  targetCountries = new Set(ranked.map(([country]) => country));

  const picked: typeof corpus.rows = [];
  const taken = new Map<string, number>();
  const short: string[] = [];
  for (const row of corpus.rows) {
    if (!targetCountries.has(row.country)) continue;
    const used = taken.get(row.country) ?? 0;
    if (used >= perCountry) continue;
    taken.set(row.country, used + 1);
    picked.push(row);
  }
  for (const [country] of ranked) {
    const got = taken.get(country) ?? 0;
    if (got < perCountry) short.push(`${country} ${got}/${perCountry}`);
  }
  rows = picked;

  const covered = ranked.reduce((sum, [, count]) => sum + count, 0);
  console.log(
    `aim      top ${targetCountries.size} countries of ${frequency.size} in ${evalRows.length} eval frames, ` +
      `up to ${perCountry} train frames each`,
  );
  console.log(`targets  ${ranked.map(([c, n]) => `${c}(${n})`).join(" ")}`);
  console.log(`covers   ${covered} of ${evalRows.length} eval frames (${((covered / evalRows.length) * 100).toFixed(0)}%)`);
  if (short.length > 0) console.log(`short    ${short.join(", ")}`);
} else if (limit > 0) {
  rows = corpus.rows.slice(0, limit);
}
if (countriesFrom !== "" && limit > 0) rows = rows.slice(0, limit);

const memory = new FileMemory(undefined, recallMode);

console.log(`corpus   train n=${corpus.rows.length} fp=${corpus.fingerprint} seed=${corpus.seed}`);
console.log(`stream   ${rows.length} of ${corpus.rows.length}${limit > 0 ? " (--limit prefix)" : ""}`);
console.log(
  `memory   ${memory.path}, ${await memory.size()} lessons, ` +
    `recall ${recallMode} (limit ${RECALL_LIMIT} applies to top only)`,
);

let learned = 0;
let refused = 0;
// Refusals are counted by reason: a store that stays empty because every lesson was
// rejected looks identical to one that was never trained, and only this tells them apart.
const refusals = new Map<string, number>();
const distances: number[] = [];

for (const [index, row] of rows.entries()) {
  const attemptId = `${corpus.seed}:${row.id}`;
  const input: ExampleInput = { imageId: row.id, imagePath: row.imagePath };

  const result = await runTask(input, {
    memory,
    twoStep,
    learn: async (guess) => {
      const distanceKm = haversineKm(guess, {
        latitude: row.latitude,
        longitude: row.longitude,
      });
      distances.push(distanceKm);

      const outcome = await reflect({
        attemptId,
        imagePath: row.imagePath,
        guess: { latitude: guess.latitude, longitude: guess.longitude, place: guess.place },
        truth: {
          latitude: row.latitude,
          longitude: row.longitude,
          country: row.country,
          region: row.region,
          subRegion: row.subRegion,
          city: row.city,
        },
        distanceKm,
      });

      if (!outcome.ok) {
        refused++;
        refusals.set(outcome.reason, (refusals.get(outcome.reason) ?? 0) + 1);
        console.log(
          `         refused ${outcome.reason}${outcome.detail === "" ? "" : `: ${outcome.detail.slice(0, 60)}`}`,
        );
        return;
      }
      await memory.remember(outcome.lesson);
      learned++;
    },
  });

  if (result.ok) {
    const distanceKm = distances[distances.length - 1] ?? Number.NaN;
    console.log(
      `[${index + 1}/${rows.length}] ${row.id} ${row.country} -> ` +
        `${result.guess.place} ${distanceKm.toFixed(0)} km` +
        `${result.hintCount > 0 ? ` | ${result.hintCount} hints, ~${result.hintTokens} tok` : ""}`,
    );
  } else {
    console.log(`[${index + 1}/${rows.length}] ${row.id} FAILED ${result.failure}: ${result.message.slice(0, 120)}`);
  }

  if ((index + 1) % snapshotEvery === 0) {
    const id = await memory.snapshot();
    console.log(`         snapshot ${id}, ${await memory.size()} lessons`);
  }
}

const finalSnapshot = await memory.snapshot();
const sorted = distances.slice().sort((a, b) => a - b);
const median = sorted.length === 0 ? Number.NaN : (sorted[sorted.length >> 1] ?? Number.NaN);

console.log("---");
console.log(`attempts scored   ${distances.length}/${rows.length}`);
console.log(`median distance   ${median.toFixed(1)} km  (training stream, not a benchmark)`);
console.log(`lessons written   ${learned}, refused ${refused}`);
if (refusals.size > 0) {
  const byReason = [...refusals.entries()].sort(([, a], [, b]) => b - a);
  console.log(`refusals          ${byReason.map(([r, c]) => `${r}=${c}`).join(", ")}`);
}
console.log(`memory size       ${await memory.size()} lessons`);
console.log(`final snapshot    ${finalSnapshot}`);
console.log(`evaluate it with  npm run experiment -- --snapshot ${finalSnapshot} --concurrency 1`);

// Spans are batched, so the last of them reach Phoenix only on shutdown.
await provider.shutdown();
