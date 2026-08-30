import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import OpenAI from "openai";
import { FileMemory } from "./memory/file/memory.ts";
import type { Hint, MemoryReader } from "./memory/memory.ts";
import { FEATURE_KEYS, type FeatureObservation, type ObserveResult } from "./observe.ts";
import { locate, type LocateChatClient, type LocateChatCompletion } from "./locate.ts";
import { MemoryToolValidationError, type MemoryRunConfig } from "./tools/memory.ts";

const run: MemoryRunConfig = {
  mode: "training",
  snapshotId: null,
  readOnly: false,
  recallLimit: 5,
};

function observed(overrides: Partial<Record<(typeof FEATURE_KEYS)[number], Partial<FeatureObservation>>>): ObserveResult {
  return {
    error: null,
    features: FEATURE_KEYS.map((key) => ({
      key,
      state: "not_visible",
      text: "",
      ...overrides[key],
    })),
  };
}

class FakeReader implements MemoryReader {
  calls: Array<{ query: string; limit: number }> = [];
  readonly emptyQueries = new Set<string>();

  async recall(query: string, limit: number): Promise<Hint[]> {
    this.calls.push({ query, limit });
    if (this.emptyQueries.has(query)) return [];
    return [{ lessonId: `lesson-${this.calls.length}`, text: `memory for ${query}` }];
  }
}

class FakeClient implements LocateChatClient {
  readonly requests: OpenAI.ChatCompletionCreateParamsNonStreaming[] = [];
  readonly wrongFirstFor = new Set<string>();
  readonly malformedFirstFor = new Set<string>();
  readonly invalidArgsFirstFor = new Set<string>();
  readonly missingFirstFor = new Set<string>();
  readonly missingAlwaysFor = new Set<string>();
  readonly multipleFirstFor = new Set<string>();
  readonly seen = new Map<string, number>();

  chat = {
    completions: {
      create: async (params: OpenAI.ChatCompletionCreateParamsNonStreaming): Promise<LocateChatCompletion> => {
        this.requests.push(params);
        const tool = params.tools?.[0];
        if (tool?.type === "function") {
          const parameters = tool.function.parameters as {
            properties?: { feature_key?: { enum?: string[] } };
          };
          const enumValue = parameters.properties?.feature_key;
          const featureKey = Array.isArray((enumValue as { enum?: unknown }).enum)
            ? String(((enumValue as { enum: unknown[] }).enum)[0])
            : "unknown";
          const attempts = (this.seen.get(featureKey) ?? 0) + 1;
          this.seen.set(featureKey, attempts);
          if (this.missingAlwaysFor.has(featureKey) || (attempts === 1 && this.missingFirstFor.has(featureKey))) {
            return { choices: [{ message: {} }] };
          }
          if (attempts === 1 && this.multipleFirstFor.has(featureKey)) {
            return {
              choices: [
                {
                  message: {
                    tool_calls: [
                      {
                        id: `call-${featureKey}-${attempts}-a`,
                        type: "function",
                        function: {
                          name: "memory_retrieve",
                          arguments: JSON.stringify({ feature_key: featureKey, query: `${featureKey} visual cue` }),
                        },
                      },
                      {
                        id: `call-${featureKey}-${attempts}-b`,
                        type: "function",
                        function: {
                          name: "memory_retrieve",
                          arguments: JSON.stringify({ feature_key: featureKey, query: `${featureKey} second cue` }),
                        },
                      },
                    ],
                  },
                },
              ],
            };
          }
          if (attempts === 1 && this.malformedFirstFor.has(featureKey)) {
            return {
              choices: [
                {
                  message: {
                    tool_calls: [
                      {
                        id: `call-${featureKey}-${attempts}`,
                        type: "function",
                        function: { name: "memory_retrieve", arguments: "{not-json}" },
                      },
                    ],
                  },
                },
              ],
            };
          }
          const toolFeatureKey =
            attempts === 1 && this.wrongFirstFor.has(featureKey)
              ? FEATURE_KEYS.find((key) => key !== featureKey) ?? "traffic_side"
              : featureKey;
          const args =
            attempts === 1 && this.invalidArgsFirstFor.has(featureKey)
              ? {
                  feature_key: toolFeatureKey,
                  query: `${featureKey} visual cue`,
                  memory_ref: "foreign",
                }
              : {
                  feature_key: toolFeatureKey,
                  query: `${featureKey} visual cue`,
                };
          return {
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      id: `call-${featureKey}-${attempts}`,
                      type: "function",
                      function: {
                        name: "memory_retrieve",
                        arguments: JSON.stringify(args),
                      },
                    },
                  ],
                },
              },
            ],
          };
        }
        return {
          provider: "fake",
          choices: [
            {
              message: {
                content: JSON.stringify({
                  latitude: 1,
                  longitude: 2,
                  place: "Fake place",
                  confidence: 0.5,
                  reasoning: "Image and grouped memory were considered.",
                }),
              },
            },
          ],
        };
      },
    },
  };
}

async function withImage<T>(fn: (path: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "loci-agent-"));
  try {
    const imagePath = join(dir, "image.png");
    return await fn(imagePath, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function hasImageUrl(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) && content.some((part) => typeof part === "object" && part !== null && "image_url" in part);
}

function analyzeText(request: OpenAI.ChatCompletionCreateParamsNonStreaming): string {
  const message = request.messages.at(-1);
  const content = message?.content;
  assert.ok(Array.isArray(content));
  const textPart = content.find(
    (part) => typeof part === "object" && part !== null && "text" in part,
  ) as { text?: unknown } | undefined;
  if (typeof textPart?.text !== "string") {
    assert.fail("expected analyze message text");
  }
  return textPart.text;
}

function analyzeMemoryGroups(request: OpenAI.ChatCompletionCreateParamsNonStreaming): Array<{
  feature: { key: string };
  status: string;
  failure: string | null;
  hits: unknown[];
}> {
  const text = analyzeText(request);
  const marker = "Memory groups:\n";
  const markerIndex = text.indexOf(marker);
  assert.ok(markerIndex >= 0);
  return JSON.parse(text.slice(markerIndex + marker.length)) as Array<{
    feature: { key: string };
    status: string;
    failure: string | null;
    hits: unknown[];
  }>;
}

function analyzeObservations(request: OpenAI.ChatCompletionCreateParamsNonStreaming): FeatureObservation[] {
  const text = analyzeText(request);
  const startMarker = "Observations:\n";
  const endMarker = "\n\nMemory groups:\n";
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker);
  assert.ok(start >= 0);
  assert.ok(end > start);
  return JSON.parse(text.slice(start + startMarker.length, end)) as FeatureObservation[];
}

test("retrieve loop processes visible features in order, retries once and disables parallel tool calls", async () => {
  await withImage(async (imagePath) => {
    const memory = new FakeReader();
    const client = new FakeClient();
    client.missingFirstFor.add("poles");

    const result = await locate(
      { attemptId: "attempt-1", imagePath },
      {
        memory,
        run,
        client,
        imageDataUri: async () => "data:image/jpeg;base64,AA==",
        observe: async () =>
          observed({
            plates: { state: "visible", text: "white rear plate" },
            poles: { state: "visible", text: "wooden pole with crossarm" },
          }),
      },
    );

    assert.deepEqual(
      client.requests
        .filter((request) => request.tools !== undefined)
        .map((request) => {
          const tool = request.tools?.[0] as unknown as {
            function: { parameters: { properties: { feature_key: { enum: string[] } } } };
          };
          const featureKey = tool.function.parameters.properties.feature_key;
          return featureKey.enum?.[0];
        }),
      ["plates", "poles", "poles"],
    );
    for (const request of client.requests.filter((item) => item.tools !== undefined)) {
      assert.equal(request.parallel_tool_calls, false);
      assert.deepEqual(request.tool_choice, { type: "function", function: { name: "memory_retrieve" } });
      assert.deepEqual(
        request.tools?.map((tool) => (tool as { function: { name: string } }).function.name),
        ["memory_retrieve"],
      );
      const tool = request.tools?.[0] as unknown as { function: { parameters: { required: string[] } } };
      assert.deepEqual(tool.function.parameters.required, ["feature_key", "query"]);
    }
    assert.deepEqual(memory.calls, [
      { query: "plates visual cue", limit: 5 },
      { query: "poles visual cue", limit: 5 },
    ]);
    assert.deepEqual(
      result.memoryGroups.map((group) => [group.feature.key, group.status, group.hits.length]),
      [
        ["plates", "hits", 1],
        ["poles", "hits", 1],
      ],
    );
    assert.deepEqual(
      result.trace.events.map((event) => [event.featureKey, event.status]),
      [
        ["plates", "hits"],
        ["poles", "missing_tool_call"],
        ["poles", "hits"],
      ],
    );
  });
});

test("not_visible observations are not retrieved but remain available to final analyze", async () => {
  await withImage(async (imagePath) => {
    const client = new FakeClient();
    const memory = new FakeReader();

    const result = await locate(
      { attemptId: "attempt-1b", imagePath },
      {
        memory,
        run,
        client,
        imageDataUri: async () => "data:image/jpeg;base64,AA==",
        observe: async () =>
          observed({
            plates: { state: "not_visible", text: "model should have normalized this upstream" },
            poles: { state: "visible", text: "wooden pole with crossarm" },
          }),
      },
    );

    const retrieveRequests = client.requests.filter((request) => request.tools !== undefined);
    assert.deepEqual(
      retrieveRequests.map((request) => {
        const tool = request.tools?.[0] as unknown as {
          function: { parameters: { properties: { feature_key: { enum: string[] } } } };
        };
        return tool.function.parameters.properties.feature_key.enum[0];
      }),
      ["poles"],
    );
    assert.deepEqual(memory.calls, [{ query: "poles visual cue", limit: 5 }]);
    assert.deepEqual(
      result.memoryGroups.map((group) => group.feature.key),
      ["poles"],
    );

    const analyze = client.requests.at(-1);
    assert.ok(analyze);
    const observations = analyzeObservations(analyze);
    assert.deepEqual(
      observations.filter((feature) => feature.state === "visible").map((feature) => feature.key),
      ["poles"],
    );
    assert.equal(observations.find((feature) => feature.key === "plates")?.state, "not_visible");
  });
});

test("final analyze sees the original image and stable feature groups without store tool or ground truth", async () => {
  await withImage(async (imagePath) => {
    const client = new FakeClient();
    const imagePaths: string[] = [];
    const result = await locate(
      { attemptId: "attempt-2", imagePath },
      {
        memory: new FakeReader(),
        run,
        client,
        imageDataUri: async (path) => {
          imagePaths.push(path);
          return "data:image/jpeg;base64,AA==";
        },
        observe: async () =>
          observed({
            traffic_side: { state: "visible", text: "traffic keeps right" },
            vegetation: { state: "visible", text: "dry scrub and sparse trees" },
          }),
      },
    );

    const analyze = client.requests.at(-1);
    assert.ok(analyze);
    assert.equal(analyze.tool_choice, "none");
    assert.equal(analyze.tools, undefined);
    assert.equal(analyze.parallel_tool_calls, false);
    assert.equal(analyze.response_format?.type, "json_schema");
    assert.ok(analyze.messages.some(hasImageUrl));
    assert.deepEqual(imagePaths, [imagePath]);
    assert.equal(JSON.stringify(analyze.messages).includes("memory_store"), false);
    assert.equal(JSON.stringify(analyze.messages).includes("ground truth"), false);
    assert.deepEqual(
      result.memoryGroups.map((group) => group.feature.key),
      ["traffic_side", "vegetation"],
    );
    const toolResultIndex = analyze.messages.findIndex((message) => message.role === "tool");
    const analyzeTurnIndex = analyze.messages.length - 1;
    assert.ok(toolResultIndex >= 0 && toolResultIndex < analyzeTurnIndex);
  });
});

test("final analyze receives one failed group after two missing retrieval calls and keeps no-hit groups", async () => {
  await withImage(async (imagePath) => {
    const client = new FakeClient();
    const memory = new FakeReader();
    client.missingAlwaysFor.add("plates");
    memory.emptyQueries.add("vegetation visual cue");

    const result = await locate(
      { attemptId: "attempt-2b", imagePath },
      {
        memory,
        run,
        client,
        imageDataUri: async () => "data:image/jpeg;base64,AA==",
        observe: async () =>
          observed({
            plates: { state: "visible", text: "white rear plate" },
            poles: { state: "visible", text: "wooden pole with crossarm" },
            vegetation: { state: "visible", text: "dry scrub and sparse trees" },
          }),
      },
    );

    const retrieveRequests = client.requests.filter((request) => request.tools !== undefined);
    assert.deepEqual(
      retrieveRequests.map((request) => {
        const tool = request.tools?.[0] as unknown as {
          function: { parameters: { properties: { feature_key: { enum: string[] } } } };
        };
        return tool.function.parameters.properties.feature_key.enum[0];
      }),
      ["plates", "plates", "poles", "vegetation"],
    );
    assert.deepEqual(memory.calls, [
      { query: "poles visual cue", limit: 5 },
      { query: "vegetation visual cue", limit: 5 },
    ]);

    assert.deepEqual(
      result.memoryGroups.map((group) => [group.feature.key, group.status, group.failure, group.hits.length]),
      [
        ["plates", "failed", "missing_tool_call", 0],
        ["poles", "hits", null, 1],
        ["vegetation", "no_hit", null, 0],
      ],
    );

    const analyze = client.requests.at(-1);
    assert.ok(analyze);
    const groups = analyzeMemoryGroups(analyze);
    assert.deepEqual(
      groups.map((group) => [group.feature.key, group.status, group.failure, group.hits.length]),
      [
        ["plates", "failed", "missing_tool_call", 0],
        ["poles", "hits", null, 1],
        ["vegetation", "no_hit", null, 0],
      ],
    );
    assert.equal(groups.filter((group) => group.status === "failed").length, 1);
  });
});

test("runtime caps retrieval attempts at two per feature and twenty-four model calls", async () => {
  await withImage(async (imagePath) => {
    const client = new FakeClient();
    for (const key of FEATURE_KEYS) client.missingAlwaysFor.add(key);

    const result = await locate(
      { attemptId: "attempt-2c", imagePath },
      {
        memory: new FakeReader(),
        run,
        client,
        maxToolAttemptsPerFeature: 3 as any,
        imageDataUri: async () => "data:image/jpeg;base64,AA==",
        observe: async () =>
          observed(
            Object.fromEntries(
              FEATURE_KEYS.map((key) => [key, { state: "visible", text: `${key} visible cue` }]),
            ) as Partial<Record<(typeof FEATURE_KEYS)[number], Partial<FeatureObservation>>>,
          ),
      },
    );

    const retrieveRequests = client.requests.filter((request) => request.tools !== undefined);
    assert.equal(retrieveRequests.length, 24);
    assert.equal(result.trace.events.length, 24);
    assert.equal(result.memoryGroups.length, FEATURE_KEYS.length);
    assert.deepEqual(
      FEATURE_KEYS.map((key) => client.seen.get(key)),
      FEATURE_KEYS.map(() => 2),
    );
    assert.deepEqual(
      result.memoryGroups.map((group) => [group.feature.key, group.status, group.failure]),
      FEATURE_KEYS.map((key) => [key, "failed", "missing_tool_call"]),
    );
  });
});

test("retrieve loop retries malformed, wrong-feature, multiple and invalid-args tool calls without Memory access on failed attempts", async () => {
  await withImage(async (imagePath) => {
    const memory = new FakeReader();
    const client = new FakeClient();
    client.wrongFirstFor.add("plates");
    client.malformedFirstFor.add("poles");
    client.invalidArgsFirstFor.add("vegetation");
    client.multipleFirstFor.add("road_markings");

    const result = await locate(
      { attemptId: "attempt-2d", imagePath },
      {
        memory,
        run,
        client,
        imageDataUri: async () => "data:image/jpeg;base64,AA==",
        observe: async () =>
          observed({
            plates: { state: "visible", text: "white rear plate" },
            poles: { state: "visible", text: "wooden pole with crossarm" },
            road_markings: { state: "visible", text: "single center line" },
            vegetation: { state: "visible", text: "dry scrub and sparse trees" },
          }),
      },
    );

    const retrieveRequests = client.requests.filter((request) => request.tools !== undefined);
    assert.deepEqual(
      retrieveRequests.map((request) => {
        const tool = request.tools?.[0] as unknown as {
          function: { parameters: { properties: { feature_key: { enum: string[] } } } };
        };
        return tool.function.parameters.properties.feature_key.enum[0];
      }),
      ["plates", "plates", "poles", "poles", "road_markings", "road_markings", "vegetation", "vegetation"],
    );
    assert.deepEqual(memory.calls, [
      { query: "plates visual cue", limit: 5 },
      { query: "poles visual cue", limit: 5 },
      { query: "road_markings visual cue", limit: 5 },
      { query: "vegetation visual cue", limit: 5 },
    ]);
    assert.deepEqual(
      result.trace.events.map((event) => [event.featureKey, event.status]),
      [
        ["plates", "wrong_feature"],
        ["plates", "hits"],
        ["poles", "malformed_tool_json"],
        ["poles", "hits"],
        ["road_markings", "multiple_tool_calls"],
        ["road_markings", "hits"],
        ["vegetation", "invalid_tool_arguments"],
        ["vegetation", "hits"],
      ],
    );
  });
});

test("locate rethrows control-plane memory validation errors instead of recording memory_error", async () => {
  await withImage(async (imagePath) => {
    const memory = new FakeReader();
    const client = new FakeClient();
    let observeCalls = 0;
    const invalidRun: MemoryRunConfig = {
      mode: "evaluation",
      snapshotId: null,
      readOnly: true,
      recallLimit: 5,
    };

    await assert.rejects(
      () =>
        locate(
          { attemptId: "attempt-2e", imagePath },
          {
            memory,
            run: invalidRun,
            client,
            imageDataUri: async () => "data:image/jpeg;base64,AA==",
            observe: async () => {
              observeCalls += 1;
              return observed({
                plates: { state: "visible", text: "white rear plate" },
              });
            },
          },
        ),
      (error) =>
        error instanceof MemoryToolValidationError &&
        error.failure === "invalid_tool_arguments" &&
        error.message === "evaluation memory must be frozen",
    );
    assert.deepEqual(memory.calls, []);
    assert.equal(observeCalls, 0);
    assert.equal(client.requests.filter((request) => request.tools === undefined).length, 0);
  });
});

test("observation failure still reaches analyze with the original image", async () => {
  await withImage(async (imagePath) => {
    const client = new FakeClient();
    const memory = new FakeReader();
    const imagePaths: string[] = [];

    const result = await locate(
      { attemptId: "attempt-3", imagePath },
      {
        memory,
        run,
        client,
        imageDataUri: async (path) => {
          imagePaths.push(path);
          return "data:image/jpeg;base64,AA==";
        },
        observe: async () => ({ features: [], error: "malformed observation response" }),
      },
    );

    assert.deepEqual(result.observations, []);
    assert.deepEqual(result.memoryGroups, []);
    assert.deepEqual(memory.calls, []);
    const analyze = client.requests.at(-1);
    assert.ok(analyze);
    assert.ok(analyze.messages.some(hasImageUrl));
    assert.deepEqual(imagePaths, [imagePath]);
  });
});

test("FileMemory all mode is bounded to top recall in the feature-scoped path", async () => {
  await withImage(async (imagePath, dir) => {
    const memoryPath = join(dir, "memory.jsonl");
    await writeFile(
      memoryPath,
      [
        JSON.stringify({
          id: "lesson-0001",
          content: "matching pole lesson",
          sourceAttemptId: "train-1",
          triggers: ["poles visual cue"],
          region: "CL",
          hits: 0,
          wins: 0,
        }),
        JSON.stringify({
          id: "lesson-0002",
          content: "unrelated plate lesson",
          sourceAttemptId: "train-2",
          triggers: ["yellow plate"],
          region: "CO",
          hits: 0,
          wins: 0,
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const result = await locate(
      { attemptId: "attempt-4", imagePath },
      {
        memory: new FileMemory(memoryPath, "all"),
        run,
        client: new FakeClient(),
        imageDataUri: async () => "data:image/jpeg;base64,AA==",
        observe: async () =>
          observed({
            poles: { state: "visible", text: "wooden pole" },
          }),
      },
    );

    assert.equal(result.memoryGroups.length, 1);
    assert.equal(result.memoryGroups[0]?.status, "hits");
    assert.deepEqual(
      result.memoryGroups[0]?.hits.map((hit) => hit.providerId),
      ["lesson-0001"],
    );
  });
});
