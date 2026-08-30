/**
 * Builds the shuffled-memory control: the same lessons, re-attached to the wrong
 * places.
 *
 * Why this control exists. A memory-on run puts several thousand extra tokens into
 * every prompt. If the score moves, "the lessons helped" and "more text helped" are
 * both consistent with that. The control holds the token volume, the sentence count
 * and the writing style fixed, and changes only which region each lesson claims to
 * be about. A gain that survives here is a gain from text; a gain that disappears
 * here came from content.
 *
 * How the swap works. Lessons are paired by a derangement - no lesson keeps its own
 * region - and then the geography inside the prose is rewritten: country name,
 * demonym and ISO code of the original region are replaced by the pair's. The
 * rewrite matters because in `all` recall mode only `content` reaches the prompt;
 * permuting the `region` and `triggers` fields alone would produce a control that is
 * byte-identical to the real run where it counts.
 *
 * Usage:
 *   node src/shuffle-memory.ts --snapshot <id> [--seed shuffle-v1]
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MEMORY_DIR } from "./memory.ts";
import type { Lesson } from "./memory.ts";

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

/**
 * Demonyms for the countries this dataset actually produces. `Intl.DisplayNames`
 * gives "Brazil" but not "Brazilian", and lessons are written in adjectives far more
 * often than in country names.
 */
const DEMONYMS: Record<string, string> = {
  AR: "Argentine", AU: "Australian", BO: "Bolivian", BR: "Brazilian", BW: "Botswanan",
  CA: "Canadian", CD: "Congolese", CN: "Chinese", DE: "German", EG: "Egyptian",
  ES: "Spanish", FI: "Finnish", FR: "French", GB: "British", ID: "Indonesian",
  IN: "Indian", IR: "Iranian", IT: "Italian", JP: "Japanese", KG: "Kyrgyz",
  KZ: "Kazakh", LA: "Lao", MA: "Moroccan", MX: "Mexican", NG: "Nigerian",
  NO: "Norwegian", NZ: "New Zealand", PE: "Peruvian", PH: "Philippine", PK: "Pakistani",
  RU: "Russian", SA: "Saudi", SE: "Swedish", TH: "Thai", TM: "Turkmen",
  TN: "Tunisian", TR: "Turkish", US: "American", ZA: "South African", ZM: "Zambian",
};

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

function countryName(code: string): string {
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

/** Case-insensitive whole-word replace that keeps the original capitalisation. */
function replaceTerm(text: string, from: string, to: string): { text: string; hits: number } {
  if (from === "" || from === to) return { text, hits: 0 };
  const pattern = new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
  let hits = 0;
  const out = text.replace(pattern, (match) => {
    hits++;
    // "brazilian" stays lowercase, "Brazilian" stays capitalised.
    return match[0] === match[0]?.toUpperCase() ? to : to.toLowerCase();
  });
  return { text: out, hits };
}

/** Deterministic derangement: rotate a seeded permutation so no index maps to itself. */
function derange(size: number, seed: string): number[] {
  const ranked = Array.from({ length: size }, (_, index) => ({
    index,
    rank: createHash("sha256").update(`${seed}:${index}`).digest().readUInt32BE(0),
  })).sort((a, b) => a.rank - b.rank || a.index - b.index);

  const order = ranked.map((entry) => entry.index);
  const mapping = new Array<number>(size);
  for (let i = 0; i < size; i++) {
    mapping[order[i] as number] = order[(i + 1) % size] as number;
  }
  return mapping;
}

const snapshotId = flag("snapshot", "");
if (snapshotId === "") {
  console.error("usage: node src/shuffle-memory.ts --snapshot <id> [--seed shuffle-v1]");
  process.exit(2);
}
const seed = flag("seed", "shuffle-v1");

const source = await readFile(join(MEMORY_DIR, `${snapshotId}.jsonl`), "utf8");
const lessons: Lesson[] = source
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as Lesson);

if (lessons.length < 2) {
  console.error(`snapshot ${snapshotId} has ${lessons.length} lessons, nothing to derange`);
  process.exit(2);
}

const mapping = derange(lessons.length, seed);
let rewritten = 0;
let untouched = 0;

const shuffled: Lesson[] = lessons.map((lesson, index) => {
  const pair = lessons[mapping[index] as number] as Lesson;
  const from = lesson.region;
  const to = pair.region;

  let content = lesson.content;
  let hits = 0;
  for (const [a, b] of [
    [countryName(from), countryName(to)],
    [DEMONYMS[from] ?? "", DEMONYMS[to] ?? countryName(to)],
    [from, to],
  ] as const) {
    const result = replaceTerm(content, a, b);
    content = result.text;
    hits += result.hits;
  }

  if (hits > 0) rewritten++;
  else untouched++;

  return {
    ...lesson,
    content,
    region: to,
    triggers: pair.triggers,
    // Counters restart: this store has no usage history of its own.
    hits: 0,
    wins: 0,
  };
});

const body = shuffled.map((lesson) => JSON.stringify(lesson)).join("\n");
const id = createHash("sha256").update(body).digest("hex").slice(0, 12);
await mkdir(MEMORY_DIR, { recursive: true });
await writeFile(join(MEMORY_DIR, `${id}.jsonl`), `${body}\n`, "utf8");

console.log(`source     ${snapshotId}, ${lessons.length} lessons`);
console.log(`rewritten  ${rewritten} lessons had geography replaced in the text`);
console.log(
  `untouched  ${untouched} lessons name no country in prose; their region label still ` +
    `changes, so every hint differs from the real run`,
);
console.log(`shuffled   ${id}`);
console.log(`evaluate   npm run experiment -- --snapshot ${id} --concurrency 1`);
