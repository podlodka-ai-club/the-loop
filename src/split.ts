/**
 * Cuts the reviewed pool into the eval corpus and the train corpus.
 *
 * The two corpora used to be drawn one after the other: eval took the best-ranked
 * frames, then train took the best of what eval had not occupied. That order was fine
 * while the pool was the whole test split, because the loser of every collision was
 * replaced from a pool five times larger than a corpus needed. It stops being fine once
 * the pool is the list of frames a person actually looked at. There is no refill left,
 * so a sequential draw hands eval the frames it likes and leaves train with the
 * remainder, and the remainder is a different distribution: fewer countries, shifted
 * towards wherever the ranking happened to run out.
 *
 * So the pool is partitioned instead of drawn twice, and the partition is chosen to make
 * the two halves resemble each other country by country. That is the property the
 * benchmark needs. A lesson distilled from Kenya can only be scored if the eval half
 * also has Kenya in it, and a per-country gap is exactly the amount of the train corpus
 * that has nowhere to pay off.
 *
 * ## Groups move whole
 *
 * Frames are not free to move one by one. The separation rule says the halves may share
 * no `id`, no `sequence`, no uploader and no 25 km grid cell, so two frames that share
 * any of those must land on the same side. Chaining that relation gives the indivisible
 * unit of the split: a group. Groups are small - the reviewed pool of 1725 frames breaks
 * into 1303 of them, the largest holding 6 frames - because the caps that produced the
 * pool already forbade the dense cases.
 *
 * Working in groups is what makes the separation rule cost nothing here. It holds by
 * construction, and there is no post-hoc repair pass that could weaken it.
 *
 * ## Why the result can be called optimal
 *
 * Balance is measured as the sum over countries of |eval frames - train frames|. Perfect
 * balance is usually unreachable and not through any fault of the search: a country with
 * three frames cannot be halved, and a country whose frames all sit in one group cannot
 * be split at all. `floorOf` computes the lower bound this pool imposes, by subset-sum
 * over each country's group sizes, so the search reports how far it is from the best
 * achievable rather than from an unreachable zero. On the 1725-frame pool the search
 * reaches the bound.
 */
import { createHash } from "node:crypto";
import { gridCellOf } from "./osv5m.ts";
import type { Row } from "./osv5m.ts";

/**
 * Frames one uploader may contribute to the pool. Inherited from the draw that staged
 * the review; checked here because a hand-edited kept list could break it, and an
 * uploader who shoots one town in one style is a single source of truth about it.
 */
const MAX_PER_CREATOR = 3;

/**
 * Relative weight of country balance against everything else. Large enough that trading
 * one frame of country balance for any amount of size balance is never worth it.
 */
const COUNTRY_WEIGHT = 1000;

/**
 * Weight of the size difference between the halves. Small next to `COUNTRY_WEIGHT`, but
 * it has to be more than 1 or the squared country term would outvote it.
 */
const SIZE_WEIGHT = 6;

/** Local search rounds. Convergence on the reviewed pool takes three. */
const MAX_PASSES = 20;

/** The pool cannot be split, and the reason is in the pool rather than in the search. */
export class SplitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SplitError";
  }
}

/** How well the two halves match, country by country. */
export type Balance = {
  /** Sum over countries of |eval frames - train frames|. Zero is a perfect match. */
  gap: number;
  /** The smallest gap any assignment of whole groups could reach on this pool. */
  floor: number;
  /** The country that matches worst, when any country is unbalanced at all. */
  worst: { country: string; gap: number } | null;
};

export type Split = {
  evalRows: Row[];
  trainRows: Row[];
  /** Indivisible groups the partition had to work with. */
  groups: number;
  balance: Balance;
  seed: string;
};

/** Frames of one country inside one group. */
type Tally = { country: string; frames: number };

type Group = {
  rows: Row[];
  size: number;
  tallies: Tally[];
  /** Deterministic tie-break: the digest of the seed and the group's lowest id. */
  key: string;
};

/**
 * Chains frames that the separation rule cannot put on opposite sides.
 *
 * Empty `sequence` and `creator` values are skipped, as they are everywhere else in this
 * repository: empty means unknown, not "the same uploader", and chaining on it would
 * fuse every anonymous frame into one unsplittable group.
 */
function groupsOf(rows: readonly Row[], seed: string): Group[] {
  const parent = new Map<string, string>(rows.map((row) => [row.id, row.id]));

  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) {
      const grandparent = parent.get(parent.get(root) as string) as string;
      parent.set(root, grandparent);
      root = grandparent;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };

  // One representative per shared key is enough: frame three joins the group through
  // frame one just as well as through frame two.
  const first = new Map<string, string>();
  for (const row of rows) {
    const keys = [`cell:${gridCellOf(row)}`];
    if (row.sequence !== "") keys.push(`sequence:${row.sequence}`);
    if (row.creator !== "") keys.push(`creator:${row.creator}`);
    for (const key of keys) {
      const seen = first.get(key);
      if (seen === undefined) first.set(key, row.id);
      else union(seen, row.id);
    }
  }

  const members = new Map<string, Row[]>();
  for (const row of rows) {
    const root = find(row.id);
    const group = members.get(root);
    if (group === undefined) members.set(root, [row]);
    else group.push(row);
  }

  const groups: Group[] = [];
  for (const rowsOfGroup of members.values()) {
    rowsOfGroup.sort((a, b) => (a.id < b.id ? -1 : 1));
    const counts = new Map<string, number>();
    for (const row of rowsOfGroup) counts.set(row.country, (counts.get(row.country) ?? 0) + 1);
    groups.push({
      rows: rowsOfGroup,
      size: rowsOfGroup.length,
      tallies: [...counts].map(([country, frames]) => ({ country, frames })),
      key: createHash("sha256").update(`${seed}:${rowsOfGroup[0]?.id}`).digest("hex").slice(0, 16),
    });
  }

  // Largest first, so the groups with the least freedom are placed while the halves are
  // still empty enough to absorb them. Ties break on the seeded digest, never on input
  // order, so the same pool always yields the same split.
  groups.sort((a, b) => b.size - a.size || (a.key < b.key ? -1 : 1));
  return groups;
}

/**
 * The best country gap any assignment of these groups could reach.
 *
 * Each country is treated on its own, which is why this is a bound and not a plan: it
 * asks whether some subset of the groups holding that country's frames sums to half of
 * them, ignoring what that choice would do to every other country. Reachable differences
 * are bounded by the country's own frame count, so the subset-sum stays small.
 */
function floorOf(groups: readonly Group[]): number {
  const parts = new Map<string, number[]>();
  for (const group of groups) {
    for (const tally of group.tallies) {
      const list = parts.get(tally.country);
      if (list === undefined) parts.set(tally.country, [tally.frames]);
      else list.push(tally.frames);
    }
  }

  let floor = 0;
  for (const sizes of parts.values()) {
    let reachable = new Set<number>([0]);
    for (const size of sizes) {
      const next = new Set<number>();
      for (const sum of reachable) {
        next.add(sum + size);
        next.add(sum - size);
      }
      reachable = next;
    }
    floor += Math.min(...[...reachable].map(Math.abs));
  }
  return floor;
}

/**
 * How well two halves match, measured from the halves themselves.
 *
 * Separate from the search on purpose. The search tracks the gap incrementally, because
 * recomputing it for every candidate move would dominate the run time; this walks the
 * finished corpora instead. `npm run sample` therefore checks the committed manifests
 * rather than trusting a number the search reported about itself.
 */
export function balanceOf(
  evalRows: readonly Row[],
  trainRows: readonly Row[],
  seed: string,
): Balance {
  const diff = new Map<string, number>();
  for (const row of evalRows) diff.set(row.country, (diff.get(row.country) ?? 0) + 1);
  for (const row of trainRows) diff.set(row.country, (diff.get(row.country) ?? 0) - 1);

  let gap = 0;
  let worst: { country: string; gap: number } | null = null;
  for (const [country, signed] of diff) {
    const size = Math.abs(signed);
    gap += size;
    if (worst === null || size > worst.gap) worst = { country, gap: size };
  }

  return {
    gap,
    floor: floorOf(groupsOf([...evalRows, ...trainRows], seed)),
    worst: worst?.gap === 0 ? null : worst,
  };
}

/**
 * Refuses a pool that breaks a cap the draw is supposed to have applied.
 *
 * Trimming the excess instead would be worse than stopping. It would change the corpus
 * without leaving a record of which frame went and why, and the kept list would no
 * longer describe the corpus built from it.
 */
function checkCaps(rows: readonly Row[]): void {
  const perSequence = new Map<string, number>();
  const perCreator = new Map<string, number>();
  for (const row of rows) {
    if (row.sequence !== "") perSequence.set(row.sequence, (perSequence.get(row.sequence) ?? 0) + 1);
    if (row.creator !== "") perCreator.set(row.creator, (perCreator.get(row.creator) ?? 0) + 1);
  }

  for (const [sequence, frames] of perSequence) {
    if (frames > 1) {
      throw new SplitError(
        `sequence ${sequence} contributes ${frames} frames to the reviewed pool, but a ` +
          `sequence is one drive down one road and may contribute one. Drop the extra ` +
          `frames with benchmark/samples/rejected.txt.`,
      );
    }
  }
  for (const [creator, frames] of perCreator) {
    if (frames > MAX_PER_CREATOR) {
      throw new SplitError(
        `uploader ${creator} contributes ${frames} frames to the reviewed pool, above the ` +
          `cap of ${MAX_PER_CREATOR}. Drop the extra frames with ` +
          `benchmark/samples/rejected.txt.`,
      );
    }
  }
}

/**
 * Partitions the reviewed pool into two halves that match country by country.
 *
 * Greedy placement of the largest groups first, then local search: single moves, then
 * swaps across the two halves. Both phases accept a change only when it lowers the cost,
 * and both walk the groups in a fixed order, so the result depends on the pool and the
 * seed and on nothing else.
 */
export function splitBalanced(rows: readonly Row[], seed: string): Split {
  checkCaps(rows);
  const groups = groupsOf(rows, seed);

  // `diff` holds eval frames minus train frames per country; `total` does the same for
  // the corpora as a whole. Both are kept up to date by `move` so that the cost of a
  // candidate change is a subtraction rather than a walk over 165 countries.
  const diff = new Map<string, number>();
  let total = 0;
  let absolute = 0;
  let squares = 0;

  const move = (group: Group, side: number): void => {
    for (const tally of group.tallies) {
      const before = diff.get(tally.country) ?? 0;
      const after = before + side * tally.frames;
      diff.set(tally.country, after);
      absolute += Math.abs(after) - Math.abs(before);
      squares += after * after - before * before;
    }
    total += side * group.size;
  };
  const cost = (): number => COUNTRY_WEIGHT * absolute + squares + SIZE_WEIGHT * total * total;

  const sides = new Array<number>(groups.length).fill(1);
  const flip = (index: number): void => {
    const side = sides[index] as number;
    move(groups[index] as Group, -2 * side);
    sides[index] = -side;
  };

  groups.forEach((group, index) => {
    move(group, 1);
    const asEval = cost();
    flip(index);
    if (cost() > asEval) flip(index);
  });

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let improved = false;

    for (let index = 0; index < groups.length; index++) {
      const before = cost();
      flip(index);
      if (cost() < before) improved = true;
      else flip(index);
    }

    // Swaps reach what single moves cannot: two groups can be worth exchanging while
    // moving either one alone makes the halves more lopsided, not less.
    for (let left = 0; left < groups.length; left++) {
      for (let right = left + 1; right < groups.length; right++) {
        if (sides[left] === sides[right]) continue;
        const before = cost();
        flip(left);
        flip(right);
        if (cost() < before) improved = true;
        else {
          flip(left);
          flip(right);
        }
      }
    }

    if (!improved) break;
  }

  const evalRows: Row[] = [];
  const trainRows: Row[] = [];
  groups.forEach((group, index) => {
    (sides[index] === 1 ? evalRows : trainRows).push(...group.rows);
  });
  evalRows.sort((a, b) => (a.id < b.id ? -1 : 1));
  trainRows.sort((a, b) => (a.id < b.id ? -1 : 1));

  return {
    evalRows,
    trainRows,
    groups: groups.length,
    balance: balanceOf(evalRows, trainRows, seed),
    seed,
  };
}
