import assert from "node:assert/strict";
import test from "node:test";
import { buildBenchmarkPairContract } from "./benchmark-metrics.ts";
import type { Manifest } from "./manifest.ts";
import type { Row } from "./osv5m.ts";
import {
  assertSameSampleOrder,
  selectTrainingRows,
  selectTrainingSample,
} from "./train-selection.ts";

test("training selection excludes eval ids and rows sharing eval sequences", () => {
  const manifest: Manifest = {
    seed: "eval-v1",
    size: 3,
    fingerprint: "fixture",
    ids: ["eval-br", "eval-us", "eval-empty-sequence"],
  };
  const pool = [
    row({ id: "eval-br", country: "BR", sequence: "seq-br" }),
    row({ id: "near-eval-br", country: "BR", sequence: "seq-br" }),
    row({ id: "train-br", country: "BR", sequence: "seq-train-br" }),
    row({ id: "eval-us", country: "US", sequence: "seq-us" }),
    row({ id: "near-eval-us", country: "US", sequence: "seq-us" }),
    row({ id: "train-us", country: "US", sequence: "seq-train-us" }),
    row({ id: "eval-empty-sequence", country: "CA", sequence: "" }),
    row({ id: "train-empty-sequence", country: "CA", sequence: "" }),
  ];

  const selection = selectTrainingRows(pool, manifest);

  assert.deepEqual([...selection.evalIds].sort(), ["eval-br", "eval-empty-sequence", "eval-us"]);
  assert.deepEqual([...selection.evalSequences].sort(), ["seq-br", "seq-us"]);
  assert.deepEqual(selection.trainPool.map((item) => item.id), [
    "train-br",
    "train-us",
    "train-empty-sequence",
  ]);
});

test("training sequence exclusion uses full CSV metadata before image availability filtering", () => {
  const manifest: Manifest = {
    seed: "eval-v1",
    size: 1,
    fingerprint: "fixture",
    ids: ["eval-missing-image"],
  };
  const metadataRows = [
    row({ id: "eval-missing-image", country: "BR", sequence: "seq-eval" }),
    row({ id: "same-sequence-on-disk", country: "BR", sequence: "seq-eval" }),
    row({ id: "train-on-disk", country: "BR", sequence: "seq-train" }),
  ];
  const availableRows = metadataRows.filter((item) => item.id !== "eval-missing-image");

  const selection = selectTrainingRows(availableRows, manifest, metadataRows);

  assert.deepEqual(selection.evalRows.map((item) => item.id), ["eval-missing-image"]);
  assert.deepEqual([...selection.evalSequences], ["seq-eval"]);
  assert.deepEqual(selection.trainPool.map((item) => item.id), ["train-on-disk"]);
});

test("control and memory-on share the same training sample order and observation cache contract", () => {
  const manifest: Manifest = {
    seed: "eval-v1",
    size: 4,
    fingerprint: "fixture",
    ids: ["eval-br-1", "eval-br-2", "eval-us-1", "eval-za-1"],
  };
  const pool = [
    row({ id: "eval-br-1", country: "BR", sequence: "eval-br-1" }),
    row({ id: "eval-br-2", country: "BR", sequence: "eval-br-2" }),
    row({ id: "eval-us-1", country: "US", sequence: "eval-us-1" }),
    row({ id: "eval-za-1", country: "ZA", sequence: "eval-za-1" }),
    row({ id: "train-br-1", country: "BR", sequence: "train-br-1", cell: "br" }),
    row({ id: "train-br-2", country: "BR", sequence: "train-br-2", cell: "br" }),
    row({ id: "train-us-1", country: "US", sequence: "train-us-1", cell: "us" }),
    row({ id: "train-za-1", country: "ZA", sequence: "train-za-1", cell: "za" }),
  ];

  const memoryOn = selectTrainingSample(pool, manifest, {
    limit: 4,
    seed: "train-v1",
    matchManifest: true,
  });
  const control = selectTrainingSample(pool, manifest, {
    limit: 4,
    seed: "train-v1",
    matchManifest: true,
  });
  const contract = buildBenchmarkPairContract({
    sampleIds: memoryOn.sample.rows.map((item) => item.id),
    sampleFingerprint: memoryOn.sample.fingerprint,
    manifestPath: "benchmark/samples/osv5m-v1-n200.txt",
    observationPromptVersion: "dynamic-features-v2",
    memoryMode: "warm",
  });

  assertSameSampleOrder(memoryOn.sample.rows, control.sample.rows);
  assert.deepEqual(memoryOn.quotas, new Map([["BR", 2], ["US", 1], ["ZA", 1]]));
  assert.deepEqual(contract.memoryOn.sampleIds, contract.control.sampleIds);
  assert.equal(contract.memoryOn.observationCacheKey, contract.control.observationCacheKey);
  assert.match(contract.observationCacheKey, /dynamic-features-v2:warm$/);
});

function row(overrides: Partial<Row> = {}): Row {
  const id = overrides.id ?? "row";
  return {
    id,
    latitude: 1,
    longitude: 2,
    country: "XX",
    region: "",
    subRegion: "",
    city: "",
    cell: "cell",
    sequence: `sequence-${id}`,
    creator: `creator-${id}`,
    capturedAt: "2026-08-31T00:00:00Z",
    imagePath: `${id}.jpg`,
    ...overrides,
  };
}
