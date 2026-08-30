import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  FEATURE_KEYS,
  eligibleFeatureObservations,
  observe,
  type FeatureObservation,
  type ObserveModelRequest,
} from "./observe.ts";

function fullObservation(
  overrides: Partial<Record<(typeof FEATURE_KEYS)[number], Partial<FeatureObservation>>> = {},
): FeatureObservation[] {
  return FEATURE_KEYS.map((key) => ({
    key,
    state: "visible",
    text: `${key.replaceAll("_", " ")} visible cue`,
    ...overrides[key],
  }));
}

async function withCacheDir<T>(fn: (cacheDir: string) => Promise<T>): Promise<T> {
  const cacheDir = await mkdtemp(join(tmpdir(), "loci-observe-"));
  try {
    return await fn(cacheDir);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
}

test("successful observation returns one ordered record per registry key and rejects geographic implications", async () => {
  await withCacheDir(async (cacheDir) => {
    const calls: ObserveModelRequest[] = [];
    const result = await observe("image-a.jpg", {
      cacheDir,
      model: async (request) => {
        calls.push(request);
        return JSON.stringify({ features: fullObservation() });
      },
    });

    assert.equal(result.error, null);
    assert.deepEqual(
      result.features.map((feature) => feature.key),
      FEATURE_KEYS,
    );
    assert.equal(result.features.length, FEATURE_KEYS.length);
    assert.equal(calls[0]?.schema.properties.features.items.properties.key.enum, FEATURE_KEYS);
    assert.deepEqual(calls[0]?.schema.properties.features.items.required, ["key", "state", "text"]);
    assert.equal(calls[0]?.schema.properties.features.minItems, FEATURE_KEYS.length);
    assert.equal(calls[0]?.schema.properties.features.maxItems, FEATURE_KEYS.length);

    const geoResult = await observe("image-b.jpg", {
      cacheDir,
      model: async () =>
        JSON.stringify({
          features: fullObservation({
            vegetation: { text: "dry vegetation suggests Brazil" },
          }),
        }),
    });
    assert.deepEqual(geoResult.features, []);
    assert.equal(geoResult.error, "malformed observation response");
  });
});

test("malformed observation records with missing duplicate or out-of-order keys return an error", async () => {
  await withCacheDir(async (cacheDir) => {
    const missing = await observe("missing-key.jpg", {
      cacheDir,
      model: async () =>
        JSON.stringify({
          features: fullObservation().slice(0, FEATURE_KEYS.length - 1),
        }),
    });
    assert.deepEqual(missing.features, []);
    assert.equal(missing.error, "malformed observation response");

    const duplicated = fullObservation({
      plates: { key: "poles" } as Partial<FeatureObservation>,
    });
    const duplicate = await observe("duplicate-key.jpg", {
      cacheDir,
      model: async () => JSON.stringify({ features: duplicated }),
    });
    assert.deepEqual(duplicate.features, []);
    assert.equal(duplicate.error, "malformed observation response");

    const outOfOrder = fullObservation();
    [outOfOrder[0], outOfOrder[1]] = [outOfOrder[1]!, outOfOrder[0]!];
    const reordered = await observe("out-of-order.jpg", {
      cacheDir,
      model: async () => JSON.stringify({ features: outOfOrder }),
    });
    assert.deepEqual(reordered.features, []);
    assert.equal(reordered.error, "malformed observation response");
  });
});

test("not_visible records are excluded from eligible features", () => {
  const features = fullObservation({
    plates: { state: "not_visible", text: "" },
    vehicles: { state: "not_visible", text: "not visible" },
  });

  assert.deepEqual(
    eligibleFeatureObservations(features).map((feature) => feature.key),
    FEATURE_KEYS.filter((key) => key !== "plates" && key !== "vehicles"),
  );
});

test("visible records stay eligible even when observation text is empty", () => {
  const features = fullObservation({
    plates: { state: "visible", text: "" },
    road_markings: { state: "visible", text: " \t " },
  });

  assert.deepEqual(
    eligibleFeatureObservations(features).map((feature) => feature.key),
    FEATURE_KEYS,
  );
});

test("geographic implication validation rejects place language without rejecting visual state text", async () => {
  await withCacheDir(async (cacheDir) => {
    const acceptedScriptTexts = [
      "Thai script with tone marks",
      "Cyrillic/Russian text on a sign",
      "Spanish text on sign",
      "Latin script",
    ];
    for (const [index, text] of acceptedScriptTexts.entries()) {
      const result = await observe(`script-${index}.jpg`, {
        cacheDir,
        model: async () =>
          JSON.stringify({
            features: fullObservation({
              script_and_language: { text },
            }),
          }),
      });
      assert.equal(result.error, null, text);
      assert.equal(result.features.find((feature) => feature.key === "script_and_language")?.text, text);
    }

    const rejectedTexts = [
      "Kenyan-style plates",
      "Mediterranean-looking stone walls",
      "Parisian architecture",
      "Scandinavian road markings",
      "Mongolian road surface",
      "Quebec-looking signs",
      "Andean terrain with dry slopes",
      "California-style highway signs",
      "road edge suggests a country",
      "dense city road lane markings",
      "country or region language appears on the sign",
    ];

    for (const [index, text] of rejectedTexts.entries()) {
      const result = await observe(`geo-${index}.jpg`, {
        cacheDir,
        model: async () =>
          JSON.stringify({
            features: fullObservation({
              built_environment: { text },
            }),
          }),
      });
      assert.deepEqual(result.features, [], text);
      assert.equal(result.error, "malformed observation response", text);
    }

    const accepted = await observe("visual-state.jpg", {
      cacheDir,
      model: async () =>
        JSON.stringify({
          features: fullObservation({
            road_markings: { text: "the word state painted in white on the road surface" },
          }),
        }),
    });
    assert.equal(accepted.error, null);
    assert.equal(
      accepted.features.find((feature) => feature.key === "road_markings")?.text,
      "the word state painted in white on the road surface",
    );

    const acceptedStyle = await observe("visual-style.jpg", {
      cacheDir,
      model: async () =>
        JSON.stringify({
          features: fullObservation({
            built_environment: { text: "modern-style low building with flat roof" },
          }),
        }),
    });
    assert.equal(acceptedStyle.error, null);

    const rejectedScript = await observe("script-place.jpg", {
      cacheDir,
      model: async () =>
        JSON.stringify({
          features: fullObservation({
            script_and_language: { text: "Cyrillic text suggests Russia" },
          }),
        }),
    });
    assert.deepEqual(rejectedScript.features, []);
    assert.equal(rejectedScript.error, "malformed observation response");
  });
});

test("runtime observation parser enforces strict object shapes", async () => {
  await withCacheDir(async (cacheDir) => {
    const topLevelExtra = await observe("top-extra.jpg", {
      cacheDir,
      model: async () => JSON.stringify({ features: fullObservation(), memory_ref: "foreign" }),
    });
    assert.deepEqual(topLevelExtra.features, []);
    assert.equal(topLevelExtra.error, "malformed observation response");

    const featureExtra = await observe("feature-extra.jpg", {
      cacheDir,
      model: async () =>
        JSON.stringify({
          features: fullObservation({
            plates: { text: "white rear plate", extra: "foreign" } as Partial<FeatureObservation>,
          }),
        }),
    });
    assert.deepEqual(featureExtra.features, []);
    assert.equal(featureExtra.error, "malformed observation response");
  });
});

test("not_visible observation text is normalized to an empty string", async () => {
  await withCacheDir(async (cacheDir) => {
    const result = await observe("not-visible-text.jpg", {
      cacheDir,
      model: async () =>
        JSON.stringify({
          features: fullObservation({
            vehicles: { state: "not_visible", text: "not visible behind glare" },
          }),
        }),
    });

    assert.equal(result.error, null);
    assert.equal(result.features.find((feature) => feature.key === "vehicles")?.text, "");
    assert.deepEqual(
      eligibleFeatureObservations(result.features).map((feature) => feature.key),
      FEATURE_KEYS.filter((key) => key !== "vehicles"),
    );
  });
});

test("same image and prompt version uses cache while changed prompt version or image path makes a new call", async () => {
  await withCacheDir(async (cacheDir) => {
    let calls = 0;
    const model = async (): Promise<string> => {
      calls += 1;
      return JSON.stringify({ features: fullObservation() });
    };

    await observe("image-a.jpg", { cacheDir, promptVersion: "v1", model });
    await observe("image-a.jpg", { cacheDir, promptVersion: "v1", model });
    assert.equal(calls, 1);

    await observe("image-a.jpg", { cacheDir, promptVersion: "v2", model });
    assert.equal(calls, 2);

    await observe("image-b.jpg", { cacheDir, promptVersion: "v2", model });
    assert.equal(calls, 3);
  });
});

test("model and parse failures return an error result without fabricated features", async () => {
  await withCacheDir(async (cacheDir) => {
    let parseCalls = 0;
    const parseFailure = await observe("bad-json.jpg", {
      cacheDir,
      model: async () => {
        parseCalls += 1;
        return "{not-json}";
      },
    });
    assert.deepEqual(parseFailure.features, []);
    assert.equal(parseFailure.error, "malformed observation response");
    const parseRetry = await observe("bad-json.jpg", {
      cacheDir,
      model: async () => {
        parseCalls += 1;
        return JSON.stringify({ features: fullObservation() });
      },
    });
    assert.equal(parseRetry.error, null);
    assert.equal(parseCalls, 2);

    let modelCalls = 0;
    const modelFailure = await observe("model-error.jpg", {
      cacheDir,
      model: async () => {
        modelCalls += 1;
        throw new Error("provider unavailable");
      },
    });
    assert.deepEqual(modelFailure.features, []);
    assert.equal(modelFailure.error, "provider unavailable");
    const modelRetry = await observe("model-error.jpg", {
      cacheDir,
      model: async () => {
        modelCalls += 1;
        return JSON.stringify({ features: fullObservation() });
      },
    });
    assert.equal(modelRetry.error, null);
    assert.equal(modelCalls, 2);
  });
});
