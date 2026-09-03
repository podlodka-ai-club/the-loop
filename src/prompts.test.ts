import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { loadPrompt, PROMPT_FILES, PROMPT_REGISTRY, type PromptName } from "./promts.ts";

const promptNames = Object.keys(PROMPT_REGISTRY) as PromptName[];

test("all agent prompt assets are unique, non-empty UTF-8 Markdown files", () => {
  assert.equal(promptNames.length, 7);
  assert.deepEqual(
    readdirSync(new URL("./promts/", import.meta.url)).filter((name) => name.endsWith(".md")).sort(),
    ["agent.md", "analyze.md", "memory-retrieve.md", "memory-store.md", "observe.md", "reflect.md", "retrieve.md"],
  );
  const paths = promptNames.map((name) => PROMPT_FILES[name]);
  assert.equal(new Set(paths).size, promptNames.length);

  for (const name of promptNames) {
    const content = loadPrompt(name);
    const bytes = readFileSync(new URL(`./promts/${name}.md`, import.meta.url));
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);

    assert.equal(decoded, content, `${name} must be decoded as UTF-8`);
    assert.ok(content.trim().length > 0, `${name} prompt must not be empty`);
    assert.match(PROMPT_FILES[name], /^src\/promts\/[^/]+\.md$/);
  }
});

test("only shared prompt assets exist and adapter-specific names/constants are absent", () => {
  assert.deepEqual(promptNames, [
    "agent",
    "observe",
    "retrieve",
    "analyze",
    "reflect",
    "memory-retrieve",
    "memory-store",
  ]);
  assert.equal(Object.keys(PROMPT_FILES).length, 7);
  assert.equal("mem0-extraction" in PROMPT_FILES, false);
  assert.equal("hindsight-retain" in PROMPT_FILES, false);
  for (const path of [
    "./memory/mem0/memory.ts",
    "./memory/hindsight/memory.ts",
    "./memory/xmemory/memory.ts",
    "./memory/file/memory.ts",
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.equal(/MEM0_EXTRACTION|HINDSIGHT_RETAIN_MISSION|mem0-extraction|hindsight-retain/.test(source), false, path);
  }
});
