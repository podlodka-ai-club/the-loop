/**
 * Content hygiene for stored lessons.
 *
 * A lesson is served to a later, blind attempt. The first eval run showed what happens
 * when reflection writes episode narrative instead of a rule: 66% of served hits said
 * that a cue was "not diagnostic", 52% named a country from an unrelated episode, and
 * 54% of wrong guesses named a country that appeared in the served text. The bank had
 * turned into a channel that leaks revealed truth across attempts.
 *
 * The rules here are structural. They do not judge whether a rule is true; they keep
 * narrative and foreign geography out of the free text so the `region` field stays the
 * only place a lesson names a country.
 */
import type { ReflectionEffect } from "./memory/memory.ts";

export type LessonHygieneInput = {
  effect: ReflectionEffect;
  content: string;
  triggers: readonly string[];
  region: string;
};

export type LessonHygieneResult = {
  /** The verdict to store: `helped` without a contrast is downgraded to `insufficient`. */
  effect: ReflectionEffect;
  content: string;
  /** Set when the verdict was downgraded, for the trace and the training log. */
  downgraded: "no_contrast" | null;
};

export type LessonHygieneViolation =
  | { code: "narrative"; match: string }
  | { code: "foreign_country"; match: string; region: string };

export class LessonHygieneError extends Error {
  readonly violation: LessonHygieneViolation;

  constructor(violation: LessonHygieneViolation) {
    super(
      violation.code === "narrative"
        ? `lesson content describes the episode instead of a cue rule: "${violation.match}"`
        : `lesson content names ${violation.match}, which is not region ${violation.region}`,
    );
    this.name = "LessonHygieneError";
    this.violation = violation;
  }
}

/**
 * Phrases that talk about the attempt, the retrieval, or the model instead of the
 * visible cue. A served lesson has no attempt to refer to.
 */
const NARRATIVE_PATTERN =
  /\b(memory|memories|memory hit|hit|hits|lesson|lessons|retriev(?:e|ed|al|es|ing)|recall(?:ed|s)?|episode|reflection|blind guess|the (?:model|agent|guess|answer)|this (?:image|photo|photograph|frame|case|attempt|episode)|in this (?:case|instance)|was (?:helpful|unhelpful|irrelevant|misleading|insufficient))\b/i;

/** Codes that Intl knows but that are not places a photo can be taken in. */
const NON_PLACE_CODES = new Set(["EU", "EZ", "UN", "QO", "XA", "XB", "ZZ"]);

/** Names and demonyms Intl does not produce but reflection prose does. */
const NAME_ALIASES: Record<string, readonly string[]> = {
  US: ["USA", "U.S.", "U.S.A.", "America", "American", "United States of America"],
  GB: ["U.K.", "Britain", "Great Britain", "British", "England", "English", "Scotland", "Scottish", "Wales", "Welsh"],
  TR: ["Turkey", "Turkish"],
  MM: ["Burma", "Myanmar", "Burmese"],
  CZ: ["Czech Republic", "Czech"],
  CI: ["Ivory Coast", "Cote d'Ivoire", "Ivorian"],
  KR: ["Korea", "Korean"],
  KP: ["Korea", "Korean"],
  CD: ["Congo", "Congolese", "DRC"],
  CG: ["Congo", "Congolese"],
  MK: ["Macedonia", "Macedonian"],
  SZ: ["Swaziland", "Swazi"],
  TL: ["East Timor", "Timorese"],
  VN: ["Viet Nam", "Vietnamese"],
  RU: ["Russian", "Russian Federation"],
  NL: ["Holland", "Dutch"],
  NO: ["Norwegian"],
  SE: ["Swedish"],
  FI: ["Finnish"],
  DK: ["Danish"],
  DE: ["German"],
  FR: ["French"],
  ES: ["Spanish"],
  PT: ["Portuguese"],
  IT: ["Italian"],
  PL: ["Polish"],
  IN: ["Indian"],
  JP: ["Japanese"],
  CN: ["Chinese"],
  TH: ["Thai"],
  PH: ["Filipino", "Philippine"],
  ID: ["Indonesian"],
  MY: ["Malaysian"],
  AU: ["Australian", "Tasmania", "Tasmanian"],
  NZ: ["New Zealander", "Kiwi"],
  CA: ["Canadian"],
  MX: ["Mexican"],
  BR: ["Brazilian"],
  AR: ["Argentine", "Argentinian"],
  CL: ["Chilean"],
  CO: ["Colombian"],
  PE: ["Peruvian"],
  ZA: ["South African"],
  KE: ["Kenyan"],
  NG: ["Nigerian"],
  EG: ["Egyptian"],
  IL: ["Israeli"],
  AE: ["Emirati"],
  SA: ["Saudi"],
  IR: ["Iranian", "Persian"],
  PK: ["Pakistani"],
  BD: ["Bangladeshi"],
  LK: ["Sri Lankan"],
  KH: ["Cambodian"],
  LA: ["Lao", "Laotian"],
  MN: ["Mongolian"],
  UA: ["Ukrainian"],
  RO: ["Romanian"],
  HU: ["Hungarian"],
  GR: ["Greek"],
  IE: ["Irish"],
  IS: ["Icelandic"],
  CH: ["Swiss"],
  AT: ["Austrian"],
  BE: ["Belgian"],
  HR: ["Croatian"],
  RS: ["Serbian"],
  BG: ["Bulgarian"],
  SK: ["Slovak"],
  SI: ["Slovenian"],
  EE: ["Estonian"],
  LV: ["Latvian"],
  LT: ["Lithuanian"],
};

type CountryName = { name: string; codes: Set<string>; pattern: RegExp };

let countryNames: CountryName[] | null = null;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeName(value: string): string {
  return value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Country names, aliases and demonyms keyed by normalized spelling, built once from Intl. */
function loadCountryNames(): CountryName[] {
  if (countryNames !== null) return countryNames;
  const display = new Intl.DisplayNames(["en"], { type: "region" });
  const byName = new Map<string, Set<string>>();
  const add = (name: string, code: string) => {
    const key = normalizeName(name);
    if (key.length < 3) return;
    const codes = byName.get(key) ?? new Set<string>();
    codes.add(code);
    byName.set(key, codes);
  };
  for (let first = 65; first < 91; first += 1) {
    for (let second = 65; second < 91; second += 1) {
      const code = String.fromCharCode(first, second);
      if (NON_PLACE_CODES.has(code)) continue;
      let name: string | undefined;
      try {
        name = display.of(code);
      } catch {
        continue;
      }
      if (name === undefined || name === code) continue;
      add(name, code);
      // "Myanmar (Burma)" and "Congo - Kinshasa" also appear as their first word.
      const bare = name.replace(/\s*\(.*\)$/, "").replace(/\s+-\s+.*$/, "");
      if (bare !== name) add(bare, code);
      for (const part of name.split(/\s*\(|\)|\s+-\s+|\s+&\s+/)) {
        if (part.length >= 4 && !/^(islands?|sar|china|republic)$/i.test(part)) add(part, code);
      }
    }
  }
  for (const [code, aliases] of Object.entries(NAME_ALIASES)) {
    for (const alias of aliases) add(alias, code);
  }
  countryNames = [...byName.entries()]
    .sort((a, b) => b[0].length - a[0].length)
    .map(([name, codes]) => ({
      name,
      codes,
      pattern: new RegExp(`(?<![a-z])${escapeRegExp(name).replace(/\s+/g, "\\s+")}(?![a-z])`, "i"),
    }));
  return countryNames;
}

/** Country names in the text whose code set does not include `region`. */
export function foreignCountryNames(text: string, region: string): string[] {
  const normalized = normalizeName(text);
  const found: string[] = [];
  for (const entry of loadCountryNames()) {
    if (entry.codes.has(region)) continue;
    if (entry.pattern.test(normalized)) found.push(entry.name);
  }
  return found;
}

/**
 * A `helped` lesson has to say what the cue looks like here and what the near
 * alternative looks like elsewhere. The second eval run served rules of the form
 * "<cue> is typical of this region" under `helped`; with a country tag attached each
 * of them pulled a later attempt toward that country, whatever the image showed. A
 * rule without a contrast is a hypothesis, so it is stored as `insufficient`.
 */
const CONTRAST_PATTERN =
  /\b(?:not|unlike|rather than|instead of|whereas|versus|as opposed to|in contrast to|differs? from|never|no longer|but no|without the)\b/i;

export function contrastMatch(text: string): string | null {
  const match = CONTRAST_PATTERN.exec(text);
  return match === null ? null : match[0];
}

export function narrativeMatch(text: string): string | null {
  const match = NARRATIVE_PATTERN.exec(text);
  return match === null ? null : match[0];
}

/**
 * Deterministic content for an `irrelevant` verdict. Such a lesson never reaches the
 * analyze prompt; it exists for reflection statistics only, so it carries the cue and
 * nothing that could leak into a later attempt if the gate is ever bypassed.
 */
export function canonicalIrrelevantContent(triggers: readonly string[]): string {
  return `Cue "${triggers.join("; ")}" was observed and did not narrow the location.`;
}

/**
 * Returns the verdict and content to store, or throws LessonHygieneError. Served
 * verdicts must be a cue rule: no episode narrative, no country other than `region`.
 * `irrelevant` is replaced by the canonical form. `helped` without a contrast clause
 * becomes `insufficient`, which the relevance gate does not serve.
 */
export function applyLessonHygiene(input: LessonHygieneInput): LessonHygieneResult {
  if (input.effect === "irrelevant") {
    return { effect: "irrelevant", content: canonicalIrrelevantContent(input.triggers), downgraded: null };
  }
  const narrative = narrativeMatch(input.content);
  if (narrative !== null) throw new LessonHygieneError({ code: "narrative", match: narrative });
  const foreign = foreignCountryNames(input.content, input.region);
  if (foreign.length > 0) {
    throw new LessonHygieneError({ code: "foreign_country", match: foreign[0]!, region: input.region });
  }
  if (input.effect === "helped" && contrastMatch(input.content) === null) {
    return { effect: "insufficient", content: input.content, downgraded: "no_contrast" };
  }
  return { effect: input.effect, content: input.content, downgraded: null };
}
