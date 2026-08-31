import assert from "node:assert/strict";
import test from "node:test";
import OpenAI from "openai";
import {
  ReflectRuntimeError,
  reflectEpisodeWithRuntime,
  type ReflectRuntimeChatClient,
} from "./reflect-runtime.internal.ts";
import type { ReflectionEpisodeInput } from "./reflect.ts";
import type { FeatureObservation } from "./observe.ts";
import type {
  Hint,
  LessonInput,
  MemoryWriteResult,
  MemoryWriter,
} from "./memory/memory.ts";
import { MemoryWriteError } from "./memory/memory.ts";
import {
  makeIdempotencyKey,
  makeMemoryHitId,
  type MemoryHit,
  type MemoryRunConfig,
  type ReflectionEffect,
} from "./tools/memory.ts";

const run: MemoryRunConfig = {
  mode: "training",
  snapshotId: null,
  readOnly: false,
  recallLimit: 5,
};

const feature: FeatureObservation = {
  key: "road_markings",
  state: "visible",
  text: "single yellow center line on a rural road",
};

const memoryHitId = makeMemoryHitId(
  "attempt-reflect",
  "road_markings",
  "lesson-source",
  "Single yellow center lines can be broad in South America.",
  0,
);

const memoryHit: MemoryHit = {
  attemptId: "attempt-reflect",
  featureKey: "road_markings",
  memoryHitId,
  providerId: "lesson-source",
  text: "Single yellow center lines can be broad in South America.",
  score: 2,
  effect: "insufficient",
};

class WriterSpy implements MemoryWriter {
  readonly invocations: Array<{ type: "remember"; lesson: LessonInput }> = [];
  result: MemoryWriteResult = { status: "stored", lessonId: "lesson-written" };
  error: Error | undefined;

  async recall(): Promise<Hint[]> {
    return [];
  }

  async remember(lesson: LessonInput): Promise<MemoryWriteResult> {
    this.invocations.push({ type: "remember", lesson });
    if (this.error !== undefined) throw this.error;
    return this.result;
  }

  async snapshot(): Promise<string> {
    return "snapshot";
  }

  async restore(): Promise<void> {}
}

class ReflectClientSpy implements ReflectRuntimeChatClient {
  readonly invocations: OpenAI.ChatCompletionCreateParamsNonStreaming[] = [];
  toolCalls: unknown[] = [toolCall({ effect: "misleading" })];
  error: Error | undefined;

  chat = {
    completions: {
      create: async (
        params: OpenAI.ChatCompletionCreateParamsNonStreaming,
      ): Promise<{ choices: Array<{ message: { tool_calls?: unknown[] } }> }> => {
        this.invocations.push(params);
        if (this.error !== undefined) throw this.error;
        return { choices: [{ message: { tool_calls: this.toolCalls } }] };
      },
    },
  };
}

function makeInput(overrides: Partial<ReflectionEpisodeInput> = {}): ReflectionEpisodeInput {
  return {
    attemptId: "attempt-reflect",
    imagePath: "image-reflect.jpg",
    feature,
    memoryHit,
    guess: {
      latitude: -23.55,
      longitude: -46.63,
      place: "Sao Paulo, Brazil",
      reasoning: "The road markings looked broadly Brazilian.",
    },
    truth: {
      latitude: -30.03,
      longitude: -51.23,
      country: "BR",
    },
    distanceKm: 842.25,
    ...overrides,
  };
}

function toolCall(overrides: Partial<{
  feature_key: string;
  memory_hit_id: string;
  effect: ReflectionEffect | "unknown";
  content: string;
  triggers: string[];
  region: string;
}> = {}): unknown {
  return {
    id: "call-store",
    type: "function",
    function: {
      name: "memory_store",
      arguments: JSON.stringify({
        feature_key: "road_markings",
        memory_hit_id: memoryHitId,
        effect: "helped",
        content: "The single yellow center line matched the revealed Brazilian road. It should stay a weak cue unless poles agree.",
        triggers: ["single yellow center line", "rural road"],
        region: "BR",
        ...overrides,
      }),
    },
  };
}

function toolCallWithArguments(args: Record<string, unknown>): unknown {
  return {
    id: "call-store",
    type: "function",
    function: {
      name: "memory_store",
      arguments: JSON.stringify(args),
    },
  };
}

function textPart(request: OpenAI.ChatCompletionCreateParamsNonStreaming): string {
  const content = request.messages[0]?.content;
  assert.ok(Array.isArray(content));
  const part = content.find((item) => typeof item === "object" && item !== null && "text" in item) as
    | { text?: unknown }
    | undefined;
  if (typeof part?.text !== "string") assert.fail("expected prompt text");
  return part.text;
}

test("reflectEpisode sends one feature and one memory hit with guess, truth, distance and image", async () => {
  const writer = new WriterSpy();
  const client = new ReflectClientSpy();

  const result = await reflectEpisodeWithRuntime(makeInput(), {
    writer,
    run,
    client,
    imageDataUri: async (imagePath) => `data:image/jpeg;base64,${imagePath}`,
  });

  assert.deepEqual(result, {
    status: "stored",
    effect: "misleading",
    lessonId: "lesson-written",
    failure: null,
  });
  assert.equal(client.invocations.length, 1);
  const request = client.invocations[0];
  assert.ok(request);
  assert.deepEqual(
    request.tools?.map((tool) => (tool.type === "function" ? tool.function.name : "custom")),
    ["memory_store"],
  );
  assert.deepEqual(request.tool_choice, { type: "function", function: { name: "memory_store" } });
  assert.equal(request.parallel_tool_calls, false);
  const tool = request.tools?.[0];
  if (tool?.type !== "function") assert.fail("expected function tool");
  assert.deepEqual(
    (tool?.function.parameters as { properties?: { feature_key?: { enum?: string[] } } }).properties
      ?.feature_key?.enum,
    ["road_markings"],
  );
  const prompt = textPart(request);
  assert.equal(prompt.includes(JSON.stringify(feature)), true);
  assert.equal(prompt.includes(memoryHitId), true);
  assert.equal(prompt.includes(memoryHit.text), true);
  assert.equal(prompt.includes("Sao Paulo, Brazil"), true);
  assert.equal(prompt.includes("\"country\":\"BR\""), true);
  assert.equal(prompt.includes("842.250"), true);
  assert.equal(
    prompt.includes("- helped: the hit supplied a cue consistent with the revealed location and useful for the answer."),
    true,
  );
  assert.equal(
    prompt.includes("- irrelevant: the hit was usable data but did not affect this image's location decision."),
    true,
  );
  assert.equal(
    prompt.includes("- misleading: the hit asserted a wrong cue or pulled the analysis toward the wrong location."),
    true,
  );
  assert.equal(
    prompt.includes("- insufficient: the hit was partly useful but did not contain enough evidence for this decision."),
    true,
  );
  assert.equal(prompt.includes("content must be one or two grounded sentences"), true);
  assert.equal(prompt.includes("triggers must be 1-8 short observable noun phrases"), true);
  assert.equal(prompt.includes("region must be the two-letter uppercase country code of the revealed truth"), true);
  assert.equal(JSON.stringify(request.messages).includes("data:image/jpeg;base64,image-reflect.jpg"), true);
});

test("reflectEpisode accepts all effect values and writes app-owned provenance", async () => {
  const effects: ReflectionEffect[] = ["helped", "irrelevant", "misleading", "insufficient"];

  for (const effect of effects) {
    const writer = new WriterSpy();
    const client = new ReflectClientSpy();
    client.toolCalls = [toolCall({ effect })];

    const result = await reflectEpisodeWithRuntime(makeInput(), {
      writer,
      run,
      client,
      imageDataUri: async () => "data:image/jpeg;base64,AA==",
    });

    assert.deepEqual(result, { status: "stored", effect, lessonId: "lesson-written", failure: null });
    assert.deepEqual(writer.invocations, [
      {
        type: "remember",
        lesson: {
          content: "The single yellow center line matched the revealed Brazilian road. It should stay a weak cue unless poles agree.",
          sourceAttemptId: "attempt-reflect",
          featureKey: "road_markings",
          memoryHitId,
          effect,
          triggers: ["single yellow center line", "rural road"],
          region: "BR",
          idempotencyKey: makeIdempotencyKey("attempt-reflect", "road_markings", memoryHitId),
        },
      },
    ]);
  }
});

test("reflectEpisode validates and stores the same canonical parsed tool arguments object", async () => {
  const writer = new WriterSpy();
  const client = new ReflectClientSpy();
  let argumentReads = 0;
  const firstPayload = {
    feature_key: "road_markings",
    memory_hit_id: memoryHitId,
    effect: "misleading",
    content: "The single yellow center line was too broad for this road type.",
    triggers: ["single yellow center line"],
    region: "BR",
  };
  const driftingPayload = {
    ...firstPayload,
    memory_hit_id: "foreign-hit",
    effect: "helped",
    region: "US",
  };
  client.toolCalls = [
    {
      id: "call-store",
      type: "function",
      function: {
        name: "memory_store",
        get arguments(): string {
          argumentReads += 1;
          return JSON.stringify(argumentReads === 1 ? firstPayload : driftingPayload);
        },
      },
    },
  ];

  const result = await reflectEpisodeWithRuntime(makeInput(), {
    writer,
    run,
    client,
    imageDataUri: async () => "data:image/jpeg;base64,AA==",
  });

  assert.equal(argumentReads, 1);
  assert.deepEqual(result, {
    status: "stored",
    effect: "misleading",
    lessonId: "lesson-written",
    failure: null,
  });
  assert.deepEqual(writer.invocations.map((invocation) => invocation.lesson.effect), ["misleading"]);
  assert.deepEqual(writer.invocations.map((invocation) => invocation.lesson.region), ["BR"]);
  assert.deepEqual(writer.invocations.map((invocation) => invocation.lesson.memoryHitId), [memoryHitId]);
});

test("reflectEpisode keeps reflection failure distinct from write failure and enforces bounds", async () => {
  const malformedScenarios: Array<{ name: string; toolCalls: unknown[]; failure: string }> = [
    { name: "missing", toolCalls: [], failure: "missing_tool_call" },
    { name: "multiple", toolCalls: [toolCall(), toolCall()], failure: "multiple_tool_calls" },
    {
      name: "malformed json",
      toolCalls: [{ function: { name: "memory_store", arguments: "{bad-json}" } }],
      failure: "malformed_tool_json",
    },
    {
      name: "three sentences",
      toolCalls: [toolCall({ content: "One. Two. Three." })],
      failure: "invalid_tool_arguments",
    },
    {
      name: "empty content",
      toolCalls: [toolCall({ content: " " })],
      failure: "invalid_tool_arguments",
    },
    {
      name: "overlong content",
      toolCalls: [toolCall({ content: "x".repeat(2_001) })],
      failure: "invalid_tool_arguments",
    },
    {
      name: "unknown effect",
      toolCalls: [toolCall({ effect: "unknown" })],
      failure: "invalid_tool_arguments",
    },
    {
      name: "empty triggers",
      toolCalls: [toolCall({ triggers: [] })],
      failure: "invalid_tool_arguments",
    },
    {
      name: "too many triggers",
      toolCalls: [toolCall({ triggers: Array.from({ length: 9 }, (_value, index) => `trigger ${index}`) })],
      failure: "invalid_tool_arguments",
    },
    {
      name: "bad region",
      toolCalls: [toolCall({ region: "Brazil" })],
      failure: "invalid_tool_arguments",
    },
    {
      name: "lowercase region",
      toolCalls: [toolCall({ region: "br" })],
      failure: "invalid_tool_arguments",
    },
    {
      name: "bad trigger",
      toolCalls: [toolCall({ triggers: ["x".repeat(129)] })],
      failure: "invalid_tool_arguments",
    },
    {
      name: "extra provenance",
      toolCalls: [
        toolCallWithArguments({
          feature_key: "road_markings",
          memory_hit_id: memoryHitId,
          effect: "misleading",
          content: "The single yellow center line was too broad for this road type.",
          triggers: ["single yellow center line"],
          region: "BR",
          sourceAttemptId: "model-owned",
        }),
      ],
      failure: "invalid_tool_arguments",
    },
  ];

  for (const scenario of malformedScenarios) {
    const writer = new WriterSpy();
    const client = new ReflectClientSpy();
    client.toolCalls = scenario.toolCalls;
    const result = await reflectEpisodeWithRuntime(makeInput(), {
      writer,
      run,
      client,
      imageDataUri: async () => "data:image/jpeg;base64,AA==",
    });
    assert.deepEqual(
      result,
      { status: "reflection_failed", effect: null, lessonId: null, failure: scenario.failure },
      scenario.name,
    );
    assert.deepEqual(writer.invocations, [], scenario.name);
  }
});

test("reflectEpisode preflights writable training runtime before image/model access", async () => {
  const writer = new WriterSpy();
  const client = new ReflectClientSpy();

  const result = await reflectEpisodeWithRuntime(makeInput(), {
    writer,
    run: { mode: "evaluation", snapshotId: "snapshot-1", readOnly: true, recallLimit: 5 },
    client,
    imageDataUri: async () => assert.fail("image must not be loaded for read-only reflection"),
  });

  assert.deepEqual(result, {
    status: "reflection_failed",
    effect: null,
    lessonId: null,
    failure: "invalid_tool_arguments",
  });
  assert.deepEqual(client.invocations, []);
  assert.deepEqual(writer.invocations, []);

  const missingWriter = await reflectEpisodeWithRuntime(makeInput(), {
    run,
    client,
    imageDataUri: async () => assert.fail("image must not be loaded without a writer"),
  } as unknown as Parameters<typeof reflectEpisodeWithRuntime>[1]);

  assert.deepEqual(missingWriter, {
    status: "reflection_failed",
    effect: null,
    lessonId: null,
    failure: "invalid_tool_arguments",
  });
  assert.deepEqual(client.invocations, []);
});

test("reflectEpisode rejects a store region unrelated to revealed truth before writing", async () => {
  const writer = new WriterSpy();
  const client = new ReflectClientSpy();
  client.toolCalls = [toolCall({ region: "US" })];

  const result = await reflectEpisodeWithRuntime(makeInput(), {
    writer,
    run,
    client,
    imageDataUri: async () => "data:image/jpeg;base64,AA==",
  });

  assert.deepEqual(result, {
    status: "reflection_failed",
    effect: null,
    lessonId: null,
    failure: "invalid_tool_arguments",
  });
  assert.equal(client.invocations.length, 1);
  assert.deepEqual(writer.invocations, []);

  client.toolCalls = [toolCall({ region: "BR" })];
  const validWriter = new WriterSpy();
  assert.deepEqual(
    await reflectEpisodeWithRuntime(makeInput({ truth: { latitude: -30.03, longitude: -51.23, country: " br " } }), {
      writer: validWriter,
      run,
      client,
      imageDataUri: async () => "data:image/jpeg;base64,AA==",
    }),
    { status: "stored", effect: "helped", lessonId: "lesson-written", failure: null },
  );
  assert.equal(validWriter.invocations.at(-1)?.lesson.region, "BR");
});

test("reflectEpisode rejects foreign hits before model and returns writer outcomes without blind retry", async () => {
  const foreignClient = new ReflectClientSpy();
  const foreignWriter = new WriterSpy();
  const foreign = await reflectEpisodeWithRuntime(
    makeInput({ memoryHit: { ...memoryHit, attemptId: "foreign-attempt" } }),
    {
      writer: foreignWriter,
      run,
      client: foreignClient,
      imageDataUri: async () => "data:image/jpeg;base64,AA==",
    },
  );

  assert.deepEqual(foreign, {
    status: "reflection_failed",
    effect: null,
    lessonId: null,
    failure: "foreign_hit",
  });
  assert.deepEqual(foreignClient.invocations, []);
  assert.deepEqual(foreignWriter.invocations, []);

  const duplicateWriter = new WriterSpy();
  duplicateWriter.result = { status: "already_stored", lessonId: "existing-lesson" };
  const duplicateClient = new ReflectClientSpy();
  duplicateClient.toolCalls = [toolCall({ effect: "irrelevant" })];
  assert.deepEqual(
    await reflectEpisodeWithRuntime(makeInput(), {
      writer: duplicateWriter,
      run,
      client: duplicateClient,
      imageDataUri: async () => "data:image/jpeg;base64,AA==",
    }),
    { status: "already_stored", effect: "irrelevant", lessonId: "existing-lesson", failure: null },
  );
  assert.equal(duplicateWriter.invocations.length, 1);
});

test("reflectEpisode returns write_failed and write_outcome_unknown without retry or rollback", async () => {
  const scenarios: Array<{
    code: "write_failed" | "write_outcome_unknown";
    error: MemoryWriteError;
  }> = [
    { code: "write_failed", error: new MemoryWriteError("write_failed") },
    { code: "write_outcome_unknown", error: new MemoryWriteError("write_outcome_unknown") },
  ];

  for (const scenario of scenarios) {
    const writer = new WriterSpy();
    writer.error = scenario.error;
    const client = new ReflectClientSpy();
    client.toolCalls = [toolCall({ effect: "insufficient" })];

    const result = await reflectEpisodeWithRuntime(makeInput(), {
      writer,
      run,
      client,
      imageDataUri: async () => "data:image/jpeg;base64,AA==",
    });

    assert.deepEqual(result, {
      status: scenario.code,
      effect: "insufficient",
      lessonId: null,
      failure: scenario.code,
    });
    assert.equal(writer.invocations.length, 1, scenario.code);
    assert.equal(client.invocations.length, 1, scenario.code);
  }
});

test("reflectEpisode propagates image and model failures as typed runtime errors without store", async () => {
  const imageWriter = new WriterSpy();
  const imageClient = new ReflectClientSpy();
  await assert.rejects(
    reflectEpisodeWithRuntime(makeInput(), {
      writer: imageWriter,
      run,
      client: imageClient,
      imageDataUri: async () => {
        throw new Error("image loader failed");
      },
    }),
    (error) => {
      assert.ok(error instanceof ReflectRuntimeError);
      assert.equal(error.code, "image_data_uri_failed");
      return true;
    },
  );
  assert.deepEqual(imageClient.invocations, []);
  assert.deepEqual(imageWriter.invocations, []);

  const modelWriter = new WriterSpy();
  const modelClient = new ReflectClientSpy();
  modelClient.error = new Error("provider rejected model call");
  await assert.rejects(
    reflectEpisodeWithRuntime(makeInput(), {
      writer: modelWriter,
      run,
      client: modelClient,
      imageDataUri: async () => "data:image/jpeg;base64,AA==",
    }),
    (error) => {
      assert.ok(error instanceof ReflectRuntimeError);
      assert.equal(error.code, "model_failed");
      return true;
    },
  );
  assert.equal(modelClient.invocations.length, 1);
  assert.deepEqual(modelWriter.invocations, []);
});
