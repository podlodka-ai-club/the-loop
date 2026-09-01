import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { XmemoryMemoryError } from "./error.ts";

export const XMEMORY_SCHEMA_PATH = "src/memory/xmemory/schema.xmd.yml";

const XMEMORY_SCHEMA_V1_SHA256 =
  "4c08c6b1e1dcf907043a531b6b42509b00d33cb10b69df15d53ccc86a9251a68";

export type LoadedXmemorySchema = {
  source: string;
  value: Record<string, unknown>;
  sha256: string;
};

type JsonValue = null | boolean | string | number | JsonValue[] | { [key: string]: JsonValue };

function schemaError(message = "The xmemory schema is invalid"): XmemoryMemoryError {
  return new XmemoryMemoryError("protocol_error", "schema", message);
}

function withSchemaBoundary<T>(operation: () => T): T {
  try {
    return operation();
  } catch {
    // Reflection against an input Proxy can run hostile traps. Never trust or retain
    // the thrown value, even when it already looks like an XmemoryMemoryError.
    throw schemaError();
  }
}

function isPlainMapping(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownKeysAreEnumerableStrings(value: object): boolean {
  return Reflect.ownKeys(value).every(
    (key) =>
      typeof key === "string" &&
      Object.prototype.propertyIsEnumerable.call(value, key) &&
      Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value"),
  );
}

function arrayHasOnlyDenseIndices(value: unknown[]): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) return false;
  const stringKeys = keys as string[];
  if (!stringKeys.includes("length") || stringKeys.length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    if (!Object.hasOwn(value, key) || !stringKeys.includes(key)) return false;
    if (!Object.prototype.propertyIsEnumerable.call(value, key)) return false;
  }
  return true;
}

function canonicalize(value: unknown, active: WeakSet<object>): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw schemaError();
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") throw schemaError();
  if (active.has(value)) throw schemaError();
  active.add(value);

  try {
    if (Array.isArray(value)) {
      if (!arrayHasOnlyDenseIndices(value)) throw schemaError();
      return value.map((item) => canonicalize(item, active));
    }

    if (!isPlainMapping(value) || !ownKeysAreEnumerableStrings(value)) throw schemaError();
    const sortedKeys = Object.keys(value).sort();
    const result: { [key: string]: JsonValue } = Object.create(null);
    for (const key of sortedKeys) {
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: canonicalize(value[key], active),
        writable: true,
      });
    }
    // Ordinary objects always enumerate integer-index keys numerically, even when they
    // were inserted in lexicographic order. JSON.stringify observes a Proxy's ownKeys
    // order, so the canonical mapping remains a mapping while "10" stays before "2".
    return new Proxy(result, { ownKeys: () => [...sortedKeys] });
  } finally {
    active.delete(value);
  }
}

function canonicalJsonValue(value: unknown): JsonValue {
  return canonicalize(value, new WeakSet());
}

export function canonicalXmemorySchemaHash(value: unknown): string {
  return withSchemaBoundary(() => {
    const canonical = canonicalJsonValue(value);
    return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
  });
}

export function validateXmemorySchema(value: unknown): asserts value is Record<string, unknown> {
  withSchemaBoundary(() => {
    const canonical = canonicalJsonValue(value);
    if (canonical === null || Array.isArray(canonical) || typeof canonical !== "object") {
      throw schemaError();
    }
    const sha256 = createHash("sha256")
      .update(JSON.stringify(canonical), "utf8")
      .digest("hex");
    if (sha256 !== XMEMORY_SCHEMA_V1_SHA256) throw schemaError();
  });
}

export async function loadXmemorySchema(
  path = XMEMORY_SCHEMA_PATH,
): Promise<LoadedXmemorySchema> {
  let source: string;
  let value: unknown;
  try {
    source = await readFile(path, "utf8");
    value = parse(source, { maxAliasCount: 0, prettyErrors: false, uniqueKeys: true });
  } catch {
    throw schemaError();
  }
  validateXmemorySchema(value);
  return { source, value, sha256: canonicalXmemorySchemaHash(value) };
}

export function assertXmemorySchemaCompatible(
  expected: LoadedXmemorySchema,
  live: unknown,
): void {
  try {
    validateXmemorySchema(live);
    if (canonicalXmemorySchemaHash(live) === expected.sha256) return;
  } catch {
    // All validation/hash failures collapse to the same exact-schema lock result.
  }
  throw new XmemoryMemoryError(
    "schema_mismatch",
    "schema",
    "The live xmemory schema does not match the committed schema",
  );
}
