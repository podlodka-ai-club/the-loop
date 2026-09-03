import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  MAX_FEATURES,
  OBSERVE_PROMPT_VERSION,
  OBSERVE_SCHEMA_VERSION,
  isNormalizedFeatureKey,
  normalizeFeatureKey,
  observe,
  OBSERVE_PROMPT,
  type ObserveModelRequest,
} from "./observe.ts";
import { loadPrompt } from "./promts.ts";

async function withFixture<T>(fn: (input: { cacheDir: string; imagePath: string }) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "loci-observe-"));
  const cacheDir = join(root, "cache");
  const imagePath = join(root, "image.bin");
  await writeFile(imagePath, Buffer.from("image-a"));
  try {
    return await fn({ cacheDir, imagePath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function response(features: readonly unknown[]): string {
  return JSON.stringify({ features });
}

test("dynamic observation accepts variable model-selected features in response order", async () => {
  await withFixture(async ({ cacheDir, imagePath }) => {
    const calls: ObserveModelRequest[] = [];
    const result = await observe(imagePath, {
      cacheDir,
      config: {
        model: "test-model",
        seed: 7,
        schemaVersion: OBSERVE_SCHEMA_VERSION,
        promptVersion: OBSERVE_PROMPT_VERSION,
      },
      model: async (request) => {
        calls.push(request);
        return response([
          { key: "Road Markings", text: "broken white center line" },
          { key: "red--bollard", text: "red reflector on a short post" },
        ]);
      },
    });

    assert.equal(result.error, null);
    assert.deepEqual(result.features, [
      { key: "road_markings", text: "broken white center line" },
      { key: "red_bollard", text: "red reflector on a short post" },
    ]);
    assert.equal(result.features.length < MAX_FEATURES, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.prompt, loadPrompt("observe"));
    assert.equal(OBSERVE_PROMPT, loadPrompt("observe"));
    assert.equal(calls[0]?.schema.properties.features.minItems, 0);
    assert.equal(calls[0]?.schema.properties.features.maxItems, MAX_FEATURES);
    assert.equal("enum" in calls[0]!.schema.properties.features.items.properties.key, false);
    assert.deepEqual(calls[0]?.schema.properties.features.items.required, ["key", "text"]);
  });
});

test("empty dynamic observation is accepted without placeholder records", async () => {
  await withFixture(async ({ cacheDir, imagePath }) => {
    const result = await observe(imagePath, {
      cacheDir,
      model: async () => response([]),
    });

    assert.deepEqual(result, { features: [], error: null });
  });
});

test("normalization enforces bounded keys, generic-key denylist and duplicate rejection", async () => {
  assert.equal(normalizeFeatureKey("  Road--Markings "), "road_markings");
  assert.equal(normalizeFeatureKey("other"), null);
  assert.equal(normalizeFeatureKey("Feature_2"), null);
  assert.equal(isNormalizedFeatureKey("custom_cue"), true);
  assert.equal(isNormalizedFeatureKey("custom-cue"), false);

  await withFixture(async ({ cacheDir, imagePath }) => {
    for (const [name, features] of [
      ["duplicate", [{ key: "Road Markings", text: "white line" }, { key: "road-markings", text: "another line" }]],
      ["generic", [{ key: "misc_1", text: "some cue" }]],
      ["invalid", [{ key: "not/a-key", text: "some cue" }]],
      [
        "too-many",
        Array.from({ length: MAX_FEATURES + 1 }, (_value, index) => ({
          key: `signal_${index + 1}`,
          text: "visible cue",
        })),
      ],
    ] as const) {
      const result = await observe(imagePath, {
        cacheDir: join(cacheDir, name),
        model: async () => response(features),
      });
      assert.deepEqual(result.features, [], name);
      assert.equal(result.error, "malformed observation response", name);
    }
  });
});

test("structurally valid geographic-looking and visible-writing text is preserved", async () => {
  await withFixture(async ({ cacheDir, imagePath }) => {
    const text = "dry asphalt suggests Brazil; Cyrillic and Russian text on a sign";
    const result = await observe(imagePath, {
      cacheDir,
      model: async () =>
        response([
          { key: "Surface Cue", text },
          { key: "Brazil", text: "visible place name printed on a sign" },
        ]),
    });

    assert.equal(result.error, null);
    assert.deepEqual(result.features, [
      { key: "surface_cue", text },
      { key: "brazil", text: "visible place name printed on a sign" },
    ]);
  });
});

test("observation cache identity includes image bytes, image path, model, seed and versions", async () => {
  await withFixture(async ({ cacheDir, imagePath }) => {
    let calls = 0;
    const model = async () => {
      calls += 1;
      return response([{ key: "surface", text: "gray paved surface" }]);
    };
    const config = {
      model: "model-a",
      seed: 1,
      schemaVersion: OBSERVE_SCHEMA_VERSION,
      promptVersion: OBSERVE_PROMPT_VERSION,
    };

    await observe(imagePath, { cacheDir, config, model });
    await observe(imagePath, { cacheDir, config, model });
    assert.equal(calls, 1);

    await observe(imagePath, { cacheDir, config: { ...config, seed: 2 }, model });
    await observe(imagePath, { cacheDir, config: { ...config, model: "model-b" }, model });
    await observe(imagePath, { cacheDir, config: { ...config, promptVersion: "prompt-b" }, model });
    await observe(imagePath, { cacheDir, config: { ...config, schemaVersion: "schema-b" }, model });
    assert.equal(calls, 5);

    await writeFile(imagePath, Buffer.from("image-b"));
    await observe(imagePath, { cacheDir, config, model });
    assert.equal(calls, 6);

    const secondPath = join(cacheDir, "same-bytes.bin");
    await writeFile(secondPath, Buffer.from("image-b"));
    await observe(secondPath, { cacheDir, config, model });
    assert.equal(calls, 7);
  });
});

test("malformed, empty and failed model responses are not cached or fabricated", async () => {
  await withFixture(async ({ cacheDir, imagePath }) => {
    let calls = 0;
    const bad = await observe(imagePath, {
      cacheDir,
      model: async () => {
        calls += 1;
        return "{not-json}";
      },
    });
    assert.deepEqual(bad, { features: [], error: "malformed observation response" });

    const retry = await observe(imagePath, {
      cacheDir,
      model: async () => {
        calls += 1;
        return response([]);
      },
    });
    assert.deepEqual(retry, { features: [], error: null });
    assert.equal(calls, 2);

    const failed = await observe(imagePath, {
      cacheDir: join(cacheDir, "failed"),
      model: async () => {
        throw new Error("provider unavailable");
      },
    });
    assert.deepEqual(failed, { features: [], error: "provider unavailable" });
  });
});
