import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { XmemoryMemoryError } from "./error.ts";
import {
  assertXmemorySchemaCompatible,
  canonicalXmemorySchemaHash,
  loadXmemorySchema,
  validateXmemorySchema,
} from "./schema.ts";

test("committed XMD source equals the normative schema in the specification", async () => {
  const specification = await readFile("docs/specs/xmemory-adapter/spec.md", "utf8");
  const match = /### 2\. XMD schema[^]*?```yaml\n([^]*?)\n```/.exec(specification);
  assert.ok(match?.[1] !== undefined);
  const loaded = await loadXmemorySchema();
  assert.equal(loaded.source.trimEnd(), match[1].trimEnd());
  assert.equal(loaded.sha256, canonicalXmemorySchemaHash(loaded.value));

  const objects = loaded.value.objects as Record<string, unknown>;
  assert.deepEqual(Object.keys(objects), ["TrainingExperience", "Insight"]);
  assert.equal("VisualCue" in objects, false);
  assert.equal("Place" in objects, false);
});

test("canonical hash sorts mappings, preserves arrays and normalizes negative zero", () => {
  const left = { z: [3, -0, { b: true, a: null }], a: "value" };
  const right = { a: "value", z: [3, 0, { a: null, b: true }] };
  assert.equal(canonicalXmemorySchemaHash(left), canonicalXmemorySchemaHash(right));
  assert.notEqual(canonicalXmemorySchemaHash(["a", "b"]), canonicalXmemorySchemaHash(["b", "a"]));
});

test("validator accepts only the exact v1 schema and canonical hash rejects edge shapes", async () => {
  const committed = await loadXmemorySchema();
  assert.doesNotThrow(() => validateXmemorySchema(committed.value));
  assert.throws(() => validateXmemorySchema(Object.create(null)), XmemoryMemoryError);
  for (const value of [null, true, "schema", 1, [], new Date(), new Map(), undefined, 1n, NaN]) {
    assert.throws(() => validateXmemorySchema(value), XmemoryMemoryError);
  }

  const sparse = Array(1);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const nonPlain = Object.create({ inherited: true }) as Record<string, unknown>;
  nonPlain.value = 1;
  const extraArray = [1] as number[] & { extra?: number };
  extraArray.extra = 2;
  for (const value of [
    { invalid: undefined },
    { invalid: Number.POSITIVE_INFINITY },
    { invalid: Symbol("x") },
    { invalid: () => undefined },
    sparse,
    cyclic,
    nonPlain,
    extraArray,
  ]) {
    assert.throws(() => canonicalXmemorySchemaHash(value), XmemoryMemoryError);
  }
});

test("schema compatibility is an exact canonical hash comparison", async () => {
  const expected = await loadXmemorySchema();
  const reordered = Object.fromEntries(Object.entries(expected.value).reverse());
  assert.doesNotThrow(() => assertXmemorySchemaCompatible(expected, reordered));

  for (const live of [
    { ...expected.value, title: "server normalized title" },
    { data_schema: expected.value },
    null,
  ]) {
    assert.throws(() => assertXmemorySchemaCompatible(expected, live), (error) => {
      assert.ok(error instanceof XmemoryMemoryError);
      assert.equal(error.code, "schema_mismatch");
      assert.equal(error.operation, "schema");
      return true;
    });
  }
});
