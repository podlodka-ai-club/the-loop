/** Shapes of `public/showcase.json`, written by `src/showcase.ts` in the repo root. */

export type Lesson = { region: string; text: string; triggers: string[] };

export type ModeResult = {
  label: string;
  snapshot: string | null;
  predicted: { lat?: number; lon?: number; place?: string };
  errorKm: number | null;
  geoscore: number | null;
  inLessonRegion: boolean;
  hintCount: number;
  hintIds: string[];
  provider: string | null;
};

export type Frame = {
  id: string;
  image: string;
  truth: {
    lat: number;
    lon: number;
    country: string;
    city: string | null;
    region: string | null;
    subRegion: string | null;
  };
  modes: Record<string, ModeResult>;
};

export type SummaryRow = {
  key: string;
  label: string;
  snapshot: string | null;
  frames: number;
  scope: string;
  medianKm: number;
  geoscore: number;
  attraction: number;
  hintedFrames: number;
};

export type Showcase = {
  corpus: string;
  model: string;
  note: string;
  summary: SummaryRow[];
  lessons: Record<string, Record<string, Lesson>>;
  frames: Frame[];
};

/**
 * The four modes the switch offers, in the order they tell the story: what the model
 * does alone, what a filtered memory does to it, what an unfiltered one does, and
 * what the same lessons do when their places are wrong.
 */
export const MODES = [
  { id: "baseline", title: "Без памяти", sub: "промпт без уроков" },
  { id: "threshold2", title: "Порог 2", sub: "top-5, минимум два редких совпадения" },
  { id: "all73", title: "Вся память", sub: "все уроки в промпте" },
  { id: "shuffled", title: "Подменённая", sub: "те же уроки, чужие регионы" },
] as const;

export type ModeId = (typeof MODES)[number]["id"];

/** Store sizes the slider offers, and the run that measured each. */
export const VOLUMES = [
  { lessons: 25, run: "lessons25" },
  { lessons: 48, run: "lessons48" },
  { lessons: 73, run: "threshold2" },
] as const;

/**
 * Which run a mode and a slider position resolve to.
 *
 * Only the threshold mode has a store size to vary: it is the same retrieval rule
 * run against 25, 48 and 73 lessons, which is what makes the menu curve visible.
 * Every other mode is defined by its store and ignores the slider.
 */
export function resolveRun(mode: ModeId, volume: number): string {
  if (mode !== "threshold2") return mode;
  return VOLUMES.find((v) => v.lessons === volume)?.run ?? "threshold2";
}

/** Frames the demo opens on, in the order they make the point. */
const LEAD = ["2287668438031230", "225599805570186"];

export function orderFrames(frames: Frame[]): Frame[] {
  const lead = LEAD.map((id) => frames.find((frame) => frame.id === id)).filter(
    (frame): frame is Frame => frame !== undefined,
  );
  return [...lead, ...frames.filter((frame) => !LEAD.includes(frame.id))];
}

export const formatKm = (km: number | null): string => {
  if (km == null) return "—";
  if (km < 10) return `${km.toFixed(1)} км`;
  if (km < 1000) return `${Math.round(km)} км`;
  return `${Math.round(km).toLocaleString("ru-RU")} км`;
};
