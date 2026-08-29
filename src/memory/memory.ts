/**
 * Memory: lessons the agent wrote about its own past attempts, and the retrieval
 * that puts them back in front of it.
 *
 * The contract is intentionally independent of how lessons are stored. A backend
 * may use a local file, a hosted memory service, or another implementation without
 * changing the task and workflow code that consumes it.
 */

/** Default number of lessons a single recall may put into the prompt. */
export const RECALL_LIMIT = Number(process.env.MEMORY_RECALL_LIMIT ?? 5);

export type Lesson = {
  id: string;
  /** Free text, the transferable part. Written by the model during reflection. */
  content: string;
  /** Which attempt produced it, so a lesson can be traced back to its episode. */
  sourceAttemptId: string;
  /** Observable features that make this lesson relevant. Used for ranking. */
  triggers: string[];
  /** Country or area the lesson talks about. Diagnostic, not used for ranking. */
  region: string;
  /** Times the lesson reached a prompt. */
  hits: number;
  /** Times it reached a prompt and the guess landed closer than the run baseline. */
  wins: number;
};

/** What reflection produces, before the store assigns provenance and counters. */
export type LessonInput = {
  content: string;
  sourceAttemptId: string;
  triggers: string[];
  region: string;
};

export type Hint = {
  lessonId: string;
  text: string;
};

export interface Memory {
  /** Lessons worth showing, most relevant first. Never throws on an empty store. */
  recall(features: string[], limit: number): Promise<Hint[]>;
  remember(lesson: LessonInput): Promise<void>;
  /** Freezes the current store to its own file and returns that file's id. */
  snapshot(): Promise<string>;
  /** Replaces the working store with a frozen one. */
  restore(id: string): Promise<void>;
}
