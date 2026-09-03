import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import OpenAI from "openai";
import { withHints } from "./agent.ts";
import { FileMemory } from "./memory/file/memory.ts";
import type { Hint, LessonInput, MemoryReader, MemoryWriter, MemoryWriteResult } from "./memory/memory.ts";
import { type FeatureObservation, type ObserveResult } from "./observe.ts";
import { locate, type LocateDeps } from "./locate.ts";
import {
  locateWithRuntime,
  type LocateRuntimeChatClient as LocateChatClient,
  type LocateRuntimeChatCompletion as LocateChatCompletion,
  type LocateRuntimeHooks,
} from "./locate-runtime.internal.ts";
import { readLocatePartialResult } from "./locate-partial.internal.ts";
import { episodeCandidatesFromGroups } from "./tools/episode-ledger.internal.ts";
import { MemoryToolValidationError, type MemoryRunConfig } from "./tools/memory.ts";
import { loadPrompt } from "./promts.ts";

const MAX_FEATURE_KEYS = Array.from({ length: 12 }, (_value, index) => `dynamic_cue_${index + 1}`);

const run: MemoryRunConfig = {
  memoryRef: "file",
  mode: "training",
  snapshotId: null,
  readOnly: false,
  recallLimit: 5,
};

test("agent solve prompt is loaded from the Markdown asset before runtime hints", () => {
  const hint: Hint = { lessonId: "lesson-1", text: "dry road surface" };
  const prompt = withHints([hint]);
  const asset = loadPrompt("agent");

  assert.equal(prompt.startsWith(asset), true);
  assert.equal(prompt.slice(asset.length).trim(), JSON.stringify([hint]));
});

function observed(overrides: Record<string, Partial<FeatureObservation>>): ObserveResult {
  return {
    error: null,
    features: Object.entries(overrides).map(([key, feature]) => ({
      key,
      text: `${key} visible cue`,
      ...feature,
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

class FakeWriter extends FakeReader implements MemoryWriter {
  rememberCalls = 0;

  async remember(_lesson: LessonInput): Promise<MemoryWriteResult> {
    this.rememberCalls += 1;
    return { status: "stored", lessonId: "fake-lesson" };
  }

  async snapshot(): Promise<string> {
    return "fake-snapshot";
  }

  async restore(_id: string): Promise<void> {}
}

class FakeClient implements LocateChatClient {
  readonly requests: OpenAI.ChatCompletionCreateParamsNonStreaming[] = [];
  readonly wrongFirstFor = new Set<string>();
  readonly malformedFirstFor = new Set<string>();
  readonly invalidArgsFirstFor = new Set<string>();
  readonly missingFirstFor = new Set<string>();
  readonly missingAlwaysFor = new Set<string>();
  readonly multipleFirstFor = new Set<string>();
  readonly analyzeErrors: Error[] = [];
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
              ? featureKey === "plates" ? "poles" : "plates"
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
        const analyzeError = this.analyzeErrors.shift();
        if (analyzeError !== undefined) throw analyzeError;
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

const _publicLocateDepsRejectRuntimeHooks = {
  memory: new FakeWriter(),
  run,
  // @ts-expect-error client is an internal runtime seam, not public LocateDeps.
  client: new FakeClient(),
} satisfies LocateDeps;
void _publicLocateDepsRejectRuntimeHooks;

test("public locate ignores runtime hooks on widened deps", async () => {
  await withImage(async (imagePath) => {
    const client = new FakeClient();
    let hiddenObserveCalls = 0;
    let hiddenImageDataUriCalls = 0;
    const widenedDeps = {
      memory: new FakeWriter(),
      run,
      observe: async () => {
        hiddenObserveCalls += 1;
        return observed({});
      },
      imageDataUri: async () => {
        hiddenImageDataUriCalls += 1;
        return "data:image/jpeg;base64,AA==";
      },
      client,
    } satisfies LocateDeps & LocateRuntimeHooks;
    const publicDeps: LocateDeps = widenedDeps;

    await assert.rejects(
      () => locate({ attemptId: "attempt-public-boundary", imagePath }, publicDeps),
      /OPENROUTER_API_KEY|ENOENT/,
    );

    assert.equal(hiddenObserveCalls, 0);
    assert.equal(hiddenImageDataUriCalls, 0);
    assert.deepEqual(client.requests, []);
  });
});

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
  const prompt = loadPrompt("analyze");
  assert.equal(text.startsWith(prompt), true);
  const data = JSON.parse(text.slice(prompt.length).trim()) as {
    memory_groups: Array<{
      feature: { key: string };
      status: string;
      failure: string | null;
      hits: unknown[];
    }>;
  };
  return data.memory_groups;
}

function analyzeObservations(request: OpenAI.ChatCompletionCreateParamsNonStreaming): FeatureObservation[] {
  const text = analyzeText(request);
  const prompt = loadPrompt("analyze");
  assert.equal(text.startsWith(prompt), true);
  const data = JSON.parse(text.slice(prompt.length).trim()) as {
    observations: FeatureObservation[];
  };
  return data.observations;
}

test("retrieve loop processes visible features in order, retries once and disables parallel tool calls", async () => {
  await withImage(async (imagePath) => {
    const memory = new FakeWriter();
    const client = new FakeClient();
    client.missingFirstFor.add("poles");

    const result = await locateWithRuntime(
      { attemptId: "attempt-1", imagePath },
      {
        memory,
        run,
        client,
        imageDataUri: async () => "data:image/jpeg;base64,AA==",
        observe: async () =>
          observed({
            plates: { text: "white rear plate" },
            poles: { text: "wooden pole with crossarm" },
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
    const retrieveMessage = client.requests[0]?.messages.at(-1);
    assert.ok(retrieveMessage);
    const retrieveContent = retrieveMessage.content;
    assert.ok(typeof retrieveContent === "string");
    assert.equal(retrieveContent.startsWith(loadPrompt("retrieve")), true);
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
    assert.deepEqual(result.episodes, []);
    const episodeCandidates = episodeCandidatesFromGroups("attempt-1", result.memoryGroups);
    assert.deepEqual(
      episodeCandidates.map((episode) => [episode.featureKey, episode.memoryHitId]),
      result.memoryGroups.flatMap((group) =>
        group.hits.map((hit) => [group.feature.key, hit.memoryHitId]),
      ),
    );
    assert.equal(Object.prototype.hasOwnProperty.call(result, "episodeCandidates"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(result.trace, "episodeCandidates"), false);
    assert.deepEqual(result.trace.episodes, []);
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

test("only model-emitted dynamic observations are retrieved and passed to final analyze", async () => {
  await withImage(async (imagePath) => {
    const client = new FakeClient();
    const memory = new FakeWriter();

    const result = await locateWithRuntime(
      { attemptId: "attempt-1b", imagePath },
      {
        memory,
        run,
        client,
        imageDataUri: async () => "data:image/jpeg;base64,AA==",
        observe: async () =>
          observed({
            poles: { text: "wooden pole with crossarm" },
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
    assert.deepEqual(observations.map((feature) => feature.key), ["poles"]);
    assert.equal(Object.prototype.hasOwnProperty.call(observations[0] ?? {}, "state"), false);
  });
});

test("null memory bypasses retrieval model turns, provider calls and memory prompt metadata", async () => {
  await withImage(async (imagePath) => {
    const client = new FakeClient();
    const memory = new FakeWriter();
    const result = await locateWithRuntime(
      { attemptId: "attempt-cold", imagePath },
      {
        memory,
        run: { memoryRef: null, mode: "production", snapshotId: null, readOnly: true, recallLimit: 5 },
        client,
        imageDataUri: async () => "data:image/jpeg;base64,AA==",
        observe: async () => observed({ poles: { text: "wooden pole with crossarm" } }),
      },
    );

    assert.equal(client.requests.filter((request) => request.tools !== undefined).length, 0);
    assert.deepEqual(memory.calls, []);
    assert.equal(memory.rememberCalls, 0);
    assert.deepEqual(result.memoryGroups.map((group) => [group.feature.key, group.status, group.query]), [
      ["poles", "no_hit", null],
    ]);
    assert.equal(result.trace.events[0]?.memoryRef, null);
    assert.equal(result.trace.events[0]?.promptVersion, undefined);
    assert.equal(result.trace.events[0]?.promptDigest, undefined);
  });
});

test("final analyze sees the original image and stable feature groups without store tool or ground truth", async () => {
  await withImage(async (imagePath) => {
    const client = new FakeClient();
    const imagePaths: string[] = [];
    const result = await locateWithRuntime(
      { attemptId: "attempt-2", imagePath },
      {
        memory: new FakeWriter(),
        run,
        client,
        imageDataUri: async (path: string) => {
          imagePaths.push(path);
          return "data:image/jpeg;base64,AA==";
        },
        observe: async () =>
          observed({
            traffic_side: { text: "traffic keeps right" },
            vegetation: { text: "dry scrub and sparse trees" },
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
    const memory = new FakeWriter();
    client.missingAlwaysFor.add("plates");
    memory.emptyQueries.add("vegetation visual cue");

    const result = await locateWithRuntime(
      { attemptId: "attempt-2b", imagePath },
      {
        memory,
        run,
        client,
        imageDataUri: async () => "data:image/jpeg;base64,AA==",
        observe: async () =>
          observed({
            plates: { text: "white rear plate" },
            poles: { text: "wooden pole with crossarm" },
            vegetation: { text: "dry scrub and sparse trees" },
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
    for (const key of MAX_FEATURE_KEYS) client.missingAlwaysFor.add(key);

    const result = await locateWithRuntime(
      { attemptId: "attempt-2c", imagePath },
      {
        memory: new FakeWriter(),
        run,
        client,
        maxToolAttemptsPerFeature: 3 as any,
        imageDataUri: async () => "data:image/jpeg;base64,AA==",
        observe: async () =>
          observed(
            Object.fromEntries(
              MAX_FEATURE_KEYS.map((key) => [key, { text: `${key} visible cue` }]),
            ),
          ),
      },
    );

    const retrieveRequests = client.requests.filter((request) => request.tools !== undefined);
    assert.equal(retrieveRequests.length, 24);
    assert.equal(result.trace.events.length, 24);
    assert.equal(result.memoryGroups.length, MAX_FEATURE_KEYS.length);
    assert.deepEqual(
      MAX_FEATURE_KEYS.map((key) => client.seen.get(key)),
      MAX_FEATURE_KEYS.map(() => 2),
    );
    assert.deepEqual(
      result.memoryGroups.map((group) => [group.feature.key, group.status, group.failure]),
      MAX_FEATURE_KEYS.map((key) => [key, "failed", "missing_tool_call"]),
    );
  });
});

test("retrieve loop retries malformed, wrong-feature, multiple and invalid-args tool calls without Memory access on failed attempts", async () => {
  await withImage(async (imagePath) => {
    const memory = new FakeWriter();
    const client = new FakeClient();
    client.wrongFirstFor.add("plates");
    client.malformedFirstFor.add("poles");
    client.invalidArgsFirstFor.add("vegetation");
    client.multipleFirstFor.add("road_markings");

    const result = await locateWithRuntime(
      { attemptId: "attempt-2d", imagePath },
      {
        memory,
        run,
        client,
        imageDataUri: async () => "data:image/jpeg;base64,AA==",
        observe: async () =>
          observed({
            plates: { text: "white rear plate" },
            poles: { text: "wooden pole with crossarm" },
            road_markings: { text: "single center line" },
            vegetation: { text: "dry scrub and sparse trees" },
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
    const memory = new FakeWriter();
    const client = new FakeClient();
    let observeCalls = 0;
    const invalidRun: MemoryRunConfig = {
      memoryRef: "file",
      mode: "evaluation",
      snapshotId: null,
      readOnly: true,
      recallLimit: 5,
    };

    await assert.rejects(
      () =>
        locateWithRuntime(
          { attemptId: "attempt-2e", imagePath },
          {
            memory,
            run: invalidRun,
            client,
            imageDataUri: async () => "data:image/jpeg;base64,AA==",
            observe: async () => {
              observeCalls += 1;
              return observed({
              plates: { text: "white rear plate" },
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
    const memory = new FakeWriter();
    const imagePaths: string[] = [];

    const result = await locateWithRuntime(
      { attemptId: "attempt-3", imagePath },
      {
        memory,
        run,
        client,
        imageDataUri: async (path: string) => {
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

test("locate rethrows the original final analyze error when partial result cannot be attached", async () => {
  await withImage(async (imagePath) => {
    const client = new FakeClient();
    const memory = new FakeWriter();
    const analyzeError = new Error("final analyze failed");
    Object.preventExtensions(analyzeError);
    client.analyzeErrors.push(analyzeError);

    let caught: unknown;
    try {
      await locateWithRuntime(
        { attemptId: "attempt-non-extensible-error", imagePath },
        {
          memory,
          run,
          client,
          imageDataUri: async () => "data:image/jpeg;base64,AA==",
          observe: async () =>
            observed({
              poles: { text: "wooden pole" },
            }),
        },
      );
    } catch (error) {
      caught = error;
    }
    assert.equal(caught, analyzeError);
    assert.deepEqual(memory.calls, [{ query: "poles visual cue", limit: 5 }]);
    assert.deepEqual(
      client.requests
        .filter((request) => request.tools !== undefined)
        .map((request) => {
          const tool = request.tools?.[0] as unknown as {
            function: { parameters: { properties: { feature_key: { enum: string[] } } } };
          };
          return tool.function.parameters.properties.feature_key.enum[0];
        }),
      ["poles"],
    );
    const partial = readLocatePartialResult(caught);
    assert.ok(partial);
    assert.deepEqual(
      partial.memoryGroups.map((group) => [group.feature.key, group.status, group.hits.length]),
      [["poles", "hits", 1]],
    );
    assert.deepEqual(
      episodeCandidatesFromGroups(partial.attemptId, partial.memoryGroups).map((candidate) => [
        candidate.featureKey,
        candidate.memoryHitId,
      ]),
      partial.memoryGroups[0]?.hits.map((hit) => ["poles", hit.memoryHitId]),
    );
    assert.equal(Object.prototype.hasOwnProperty.call(partial.trace, "episodeCandidates"), false);
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

    const result = await locateWithRuntime(
      { attemptId: "attempt-4", imagePath },
      {
        memory: new FileMemory(memoryPath, "all"),
        run,
        client: new FakeClient(),
        imageDataUri: async () => "data:image/jpeg;base64,AA==",
        observe: async () =>
          observed({
            poles: { text: "wooden pole" },
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
