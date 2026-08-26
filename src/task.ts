/**
 * The experiment task: run the agent on one dataset example and never throw.
 *
 * A throwing task loses the row, which silently shrinks the denominator. Returning a
 * structured failure keeps the item in the run so the failure rate stays honest.
 */
import { UnparseableOutputError, geolocate } from "./agent.ts";
import type { Guess } from "./agent.ts";

export type FailureKind = "unparseable" | "api_error" | "missing_image";

export type TaskResult =
  | { ok: true; guess: Guess }
  | { ok: false; failure: FailureKind; message: string };

export type ExampleInput = {
  imageId: string;
  imagePath: string;
};

export async function runTask(input: ExampleInput): Promise<TaskResult> {
  try {
    return { ok: true, guess: await geolocate(input.imagePath) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UnparseableOutputError) {
      return { ok: false, failure: "unparseable", message };
    }
    if (message.includes("ENOENT")) {
      return { ok: false, failure: "missing_image", message };
    }
    return { ok: false, failure: "api_error", message };
  }
}
