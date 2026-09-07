const SENTENCE_PUNCTUATION = /[.!?]/u;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const CLOSING_PUNCTUATION = new Set([
  '"',
  "'",
  ")",
  "]",
  "}",
  "»",
  "”",
  "’",
]);

const ABBREVIATION_PATTERN = /\b(?:[A-Za-z]\.)+[A-Za-z]\./gu;
const COMMON_ABBREVIATION_PATTERN = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|vs|etc)\./giu;

const sentenceSegmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "sentence" })
    : undefined;

function abbreviationPeriods(value: string): Set<number> {
  const periods = new Set<number>();
  for (const pattern of [ABBREVIATION_PATTERN, COMMON_ABBREVIATION_PATTERN]) {
    for (const match of value.matchAll(pattern)) {
      const start = match.index;
      if (start === undefined) continue;
      for (let offset = 0; offset < match[0].length; offset += 1) {
        if (match[0][offset] === ".") periods.add(start + offset);
      }
    }
  }
  return periods;
}

/**
 * Counts sentence-like units in a memory lesson.
 *
 * Intl.Segmenter supplies the normal-language baseline. The small tokenizer
 * below supplements it for malformed-but-common model output where a new
 * sentence starts without whitespace ('Two.Three.' or 'two.three.'), while
 * ignoring decimal numbers and abbreviations such as 'e.g.'.
 */
export function countSentences(content: string): number {
  const value = content.trim();
  if (value === "") return 0;

  const segmentedCount = sentenceSegmenter === undefined
    ? 0
    : Array.from(sentenceSegmenter.segment(value)).length;
  return Math.max(segmentedCount, countSentenceBoundaries(value));
}

function countSentenceBoundaries(value: string): number {
  const ignoredPeriods = abbreviationPeriods(value);
  let count = 0;
  let index = 0;

  while (index < value.length) {
    if (!SENTENCE_PUNCTUATION.test(value[index] ?? "")) {
      index += 1;
      continue;
    }

    const start = index;
    while (index < value.length && SENTENCE_PUNCTUATION.test(value[index] ?? "")) {
      index += 1;
    }
    const end = index;
    const hasNonAbbreviationPunctuation = Array.from(
      { length: end - start },
      (_unused, offset) => start + offset,
    ).some((position) => !ignoredPeriods.has(position));
    if (!hasNonAbbreviationPunctuation) continue;

    const previous = value[start - 1] ?? "";
    const next = value[end] ?? "";
    if (/\d/u.test(previous) && /\d/u.test(next)) continue;

    let afterClosing = end;
    while (afterClosing < value.length && CLOSING_PUNCTUATION.has(value[afterClosing] ?? "")) {
      afterClosing += 1;
    }
    const following = value[afterClosing] ?? "";
    if (
      afterClosing === value.length ||
      /\s/u.test(following) ||
      LETTER_OR_NUMBER.test(following)
    ) {
      count += 1;
    }
  }

  return count === 0 ? 1 : count;
}
