import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { XmemoryMemoryError } from "./error.ts";

export const XMEMORY_SCHEMA_PATH = "src/memory/xmemory/schema.xmd.yml";

const XMEMORY_SCHEMA_V1_SHA256 =
  "723e1013c912d76e32140564eb5307c424f2106a28aa02666f07e9ad96460b25";

export type LoadedXmemorySchema = {
  source: string;
  value: Record<string, unknown>;
  sha256: string;
};

type JsonValue = null | boolean | string | number | JsonValue[] | { [key: string]: JsonValue };

function schemaError(message = "The xmemory schema is invalid"): XmemoryMemoryError {
  return new XmemoryMemoryError("protocol_error", "schema", message);
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
    const result: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalize(value[key], active);
    }
    return result;
  } finally {
    active.delete(value);
  }
}

function canonicalJsonValue(value: unknown): JsonValue {
  return canonicalize(value, new WeakSet());
}

export function canonicalXmemorySchemaHash(value: unknown): string {
  const canonical = canonicalJsonValue(value);
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

export function validateXmemorySchema(value: unknown): asserts value is Record<string, unknown> {
  const canonical = canonicalJsonValue(value);
  if (canonical === null || Array.isArray(canonical) || typeof canonical !== "object") {
    throw schemaError("The xmemory schema must be a mapping");
  }
  const sha256 = createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
  if (sha256 !== XMEMORY_SCHEMA_V1_SHA256) {
    throw schemaError("The xmemory schema does not match the v1 contract");
  }
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
  } catch {
    throw new XmemoryMemoryError(
      "schema_mismatch",
      "schema",
      "The live xmemory schema does not match the committed schema",
    );
  }
  if (canonicalXmemorySchemaHash(live) !== expected.sha256) {
    throw new XmemoryMemoryError(
      "schema_mismatch",
      "schema",
      "The live xmemory schema does not match the committed schema",
    );
  }
}
