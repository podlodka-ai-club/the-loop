import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { XmemoryMemoryError } from "./error.ts";
import {
  assertXmemorySchemaCompatible,
  canonicalXmemorySchemaHash,
  loadXmemorySchema,
  validateXmemorySchema,
} from "./schema.ts";

function assertSanitizedSchemaFailure(
  operation: () => unknown,
  forbidden: readonly string[],
  original?: Error,
): void {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof XmemoryMemoryError);
    assert.notEqual(error, original);
    assert.equal(error.code, "protocol_error");
    assert.equal(error.operation, "schema");
    assert.equal(error.retryable, false);
    assert.equal(error.message, "The xmemory schema is invalid");
    assert.equal("cause" in error, false);
    const visible = [error.message, String(error), error.stack ?? "", JSON.stringify(error)];
    for (const representation of visible) {
      for (const value of forbidden) assert.equal(representation.includes(value), false);
    }
    return true;
  });
}

test("committed XMD models nullable no-hit provenance and application-owned deduplication", async () => {
  const loaded = await loadXmemorySchema();
  assert.equal(loaded.sha256, canonicalXmemorySchemaHash(loaded.value));

  const objects = loaded.value.objects as Record<string, unknown>;
  assert.deepEqual(Object.keys(objects), ["TrainingExperience", "Insight"]);
  assert.equal("VisualCue" in objects, false);
  assert.equal("Place" in objects, false);

  const experience = objects.TrainingExperience as Record<string, unknown>;
  const fields = experience.fields as Record<string, Record<string, unknown>>;
  assert.equal(fields.memory_hit_id?.type, "str");
  assert.equal(fields.memory_hit_id?.required, false);
  assert.equal(fields.memory_hit_id?.default, null);
  assert.equal((experience.primary_key as string[]).join(","), "source_attempt_id,feature_key,idempotency_key");
  assert.equal((experience.primary_key as string[]).includes("memory_hit_id"), false);
});

test("canonical hash sorts mappings, preserves arrays and normalizes negative zero", () => {
  const left = { z: [3, -0, { b: true, a: null }], a: "value" };
  const right = { a: "value", z: [3, 0, { a: null, b: true }] };
  assert.equal(canonicalXmemorySchemaHash(left), canonicalXmemorySchemaHash(right));
  assert.notEqual(canonicalXmemorySchemaHash(["a", "b"]), canonicalXmemorySchemaHash(["b", "a"]));
});

test("canonical hash serializes integer-like mapping keys in JS lexicographic order", () => {
  const rootJson = '{"10":"ten","2":"two"}';
  const nestedJson = '{"outer":{"10":10,"2":2}}';
  assert.equal(
    canonicalXmemorySchemaHash({ "2": "two", "10": "ten" }),
    createHash("sha256").update(rootJson, "utf8").digest("hex"),
  );
  assert.equal(
    canonicalXmemorySchemaHash({ outer: { "2": 2, "10": 10 } }),
    createHash("sha256").update(nestedJson, "utf8").digest("hex"),
  );
});

test("canonical hash is SHA-256 of canonical scalar and shared-object JSON", () => {
  for (const value of [null, false, true, "schema", 0, 42.5]) {
    const expected = createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
    assert.equal(canonicalXmemorySchemaHash(value), expected);
  }

  const shared = { nested: true };
  assert.equal(
    canonicalXmemorySchemaHash({ left: shared, right: shared }),
    canonicalXmemorySchemaHash({ left: { nested: true }, right: { nested: true } }),
  );
});

test("canonical hash preserves root and nested own __proto__ keys", async () => {
  const rootCollision = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
  const nestedCollision = JSON.parse('{"nested":{"__proto__":"drift"}}') as Record<
    string,
    unknown
  >;
  assert.equal(Object.hasOwn(rootCollision, "__proto__"), true);
  assert.notEqual(canonicalXmemorySchemaHash(rootCollision), canonicalXmemorySchemaHash({}));
  assert.notEqual(
    canonicalXmemorySchemaHash(nestedCollision),
    canonicalXmemorySchemaHash({ nested: {} }),
  );

  const expected = await loadXmemorySchema();
  const liveWithCollision = JSON.parse(JSON.stringify(expected.value)) as Record<string, unknown>;
  Object.defineProperty(liveWithCollision, "__proto__", {
    enumerable: true,
    value: { unexpected: "schema drift" },
  });
  assert.notEqual(canonicalXmemorySchemaHash(liveWithCollision), expected.sha256);
  assert.throws(() => assertXmemorySchemaCompatible(expected, liveWithCollision), (error) => {
    assert.ok(error instanceof XmemoryMemoryError);
    assert.equal(error.code, "schema_mismatch");
    return true;
  });
});

test("schema hash, validator and compatibility sanitize hostile root and nested Proxy traps", async () => {
  const expected = await loadXmemorySchema();
  const revoked = Proxy.revocable<Record<string, unknown>>({ value: true }, {});
  revoked.revoke();

  const ownKeysError = new TypeError("trap-ownKeys-secret");
  const prototypeError = new Error("trap-getPrototypeOf-secret");
  const descriptorError = new XmemoryMemoryError(
    "authorization",
    "read",
    "trap-getOwnPropertyDescriptor-secret",
  );
  const getError = new Error("trap-get-secret");
  const hostile: Array<{ value: object; forbidden: string[]; original?: Error }> = [
    { value: revoked.proxy, forbidden: ["revoked"] },
    {
      value: new Proxy(
        { value: true },
        { ownKeys: () => { throw ownKeysError; } },
      ),
      forbidden: [ownKeysError.message],
      original: ownKeysError,
    },
    {
      value: new Proxy(
        { value: true },
        { getPrototypeOf: () => { throw prototypeError; } },
      ),
      forbidden: [prototypeError.message],
      original: prototypeError,
    },
    {
      value: new Proxy(
        { value: true },
        { getOwnPropertyDescriptor: () => { throw descriptorError; } },
      ),
      forbidden: [descriptorError.message],
      original: descriptorError,
    },
    {
      value: new Proxy(
        { value: true },
        { get: () => { throw getError; } },
      ),
      forbidden: [getError.message],
      original: getError,
    },
  ];

  for (const item of hostile) {
    for (const value of [item.value, { nested: item.value }]) {
      assertSanitizedSchemaFailure(
        () => canonicalXmemorySchemaHash(value),
        item.forbidden,
        item.original,
      );
      assertSanitizedSchemaFailure(
        () => validateXmemorySchema(value),
        item.forbidden,
        item.original,
      );
      assert.throws(() => assertXmemorySchemaCompatible(expected, value), (error) => {
        assert.ok(error instanceof XmemoryMemoryError);
        assert.notEqual(error, item.original);
        assert.equal(error.code, "schema_mismatch");
        assert.equal(error.operation, "schema");
        assert.equal(error.retryable, false);
        assert.equal(
          error.message,
          "The live xmemory schema does not match the committed schema",
        );
        assert.equal("cause" in error, false);
        const visible = [error.message, String(error), error.stack ?? "", JSON.stringify(error)];
        for (const representation of visible) {
          for (const forbidden of item.forbidden) {
            assert.equal(representation.includes(forbidden), false);
          }
        }
        return true;
      });
    }
  }
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
  const symbolKeyed = { valid: true } as Record<PropertyKey, unknown>;
  symbolKeyed[Symbol("invalid")] = true;
  const hidden = { visible: true };
  Object.defineProperty(hidden, "hidden", { value: true });
  const accessor = {};
  Object.defineProperty(accessor, "value", { enumerable: true, get: () => true });
  for (const value of [
    { invalid: undefined },
    { invalid: Number.POSITIVE_INFINITY },
    { invalid: Symbol("x") },
    { invalid: () => undefined },
    sparse,
    cyclic,
    nonPlain,
    extraArray,
    symbolKeyed,
    hidden,
    accessor,
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
