import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { loadXmemoryIntegrationConfig, xmemoryIntegrationEnabled } from "./integration.ts";
import {
  createXmemoryPlatformPort,
  decodePilotExperienceRows,
  decodePilotInsightRows,
  decodeXmemoryRawTables,
} from "./platform.ts";
import { assertXmemorySchemaCompatible, loadXmemorySchema } from "./schema.ts";

const integrationTest = xmemoryIntegrationEnabled() ? test : test.skip;

integrationTest(
  "xmemory Cloud round-trips exact schema, provenance tables and synthesized recall",
  { timeout: 300_000 },
  async (context) => {
    const config = loadXmemoryIntegrationConfig();
    const port = createXmemoryPlatformPort({
      apiKey: config.apiKey,
      instanceId: config.integrationInstanceId,
    });

    try {
      const expected = await loadXmemorySchema();
      assertXmemorySchemaCompatible(expected, await port.getSchema(60_000));

      const empty = await port.read({
        query: "List every TrainingExperience record. Return source_attempt_id only.",
        readMode: "raw-tables",
        traceId: randomUUID(),
        timeoutMs: 60_000,
      });
      const emptyTables = decodeXmemoryRawTables(empty.readerResult);
      assert.ok(emptyTables === null || emptyTables.rows.length === 0, "integration instance is not empty");

      const sourceAttemptId = `xmemory-contract-spike-${randomUUID()}`;
      const lesson =
        "In rural Iceland, slender yellow roadside delineators beside treeless lava or moss " +
        "terrain can support an Iceland hypothesis, but this cue is suggestive rather than decisive.";
      const envelope = `<loci_training_experience_v1>\n<loci_provenance_v1>\nsource_attempt_id: ${sourceAttemptId}\nregion_json: "Iceland"\nobserved_triggers_json: ["yellow roadside delineators","treeless lava terrain"]\n</loci_provenance_v1>\n<loci_lesson_v1>\n${lesson}\n</loci_lesson_v1>\n</loci_training_experience_v1>`;
      await port.write({
        text: envelope,
        extractionLogic: "deep",
        diffEngine: true,
        timeoutMs: 180_000,
      });

      const source = await port.read({
        query:
          `Return source_attempt_id for the TrainingExperience whose source_attempt_id is "${sourceAttemptId}".\n` +
          "Use exactly one column named source_attempt_id.",
        readMode: "raw-tables",
        traceId: randomUUID(),
        timeoutMs: 60_000,
      });
      assert.deepEqual(decodePilotExperienceRows(source.readerResult), [{ sourceAttemptId }]);

      const insights = await port.read({
        query:
          "Return every Insight connected through derived_from to the TrainingExperience whose\n" +
          `source_attempt_id is "${sourceAttemptId}". Use exactly these columns in this order:\n` +
          "source_attempt_id, insight_statement, insight_kind.",
        readMode: "raw-tables",
        traceId: randomUUID(),
        timeoutMs: 60_000,
      });
      const insightRows = decodePilotInsightRows(insights.readerResult);
      assert.ok(insightRows.length > 0);
      assert.ok(insightRows.every((row) => row.sourceAttemptId === sourceAttemptId));

      const recall = await port.read({
        query:
          "Use only stored Loci Insights to help interpret a new photograph.\n" +
          "Visible features:\n" +
          "- yellow roadside delineators\n" +
          "- treeless lava terrain\n" +
          "Return at most 5 distinct grounded insights. Preserve conditions, counter-signals,\n" +
          "comparisons and caveats. Do not invent observations or claim a final location.",
        readMode: "single-answer",
        traceId: randomUUID(),
        timeoutMs: 60_000,
      });
      assert.ok(
        typeof recall.readerResult === "object" &&
          recall.readerResult !== null &&
          !Array.isArray(recall.readerResult) &&
          typeof (recall.readerResult as Record<string, unknown>).answer === "string" &&
          ((recall.readerResult as Record<string, unknown>).answer as string).trim() !== "",
      );
    } finally {
      context.diagnostic(
        `xmemory integration instance ${config.integrationInstanceId} is retired and must not be reused`,
      );
    }
  },
);
