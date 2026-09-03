import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/** The only registry of prompt names, runtime paths and trace versions. */
export const PROMPT_REGISTRY = {
  agent: { path: "src/promts/agent.md", version: "agent-v1" },
  observe: { path: "src/promts/observe.md", version: "dynamic-features-v2" },
  retrieve: { path: "src/promts/retrieve.md", version: "retrieve-v1" },
  analyze: { path: "src/promts/analyze.md", version: "analyze-v1" },
  reflect: { path: "src/promts/reflect.md", version: "reflect-v1" },
  "memory-retrieve": { path: "src/promts/memory-retrieve.md", version: "memory-retrieve-v1" },
  "memory-store": { path: "src/promts/memory-store.md", version: "memory-store-v1" },
} as const;

export type PromptName = keyof typeof PROMPT_REGISTRY;
type PromptRegistry = typeof PROMPT_REGISTRY;

export const PROMPT_FILES = Object.fromEntries(
  Object.entries(PROMPT_REGISTRY).map(([name, entry]) => [name, entry.path]),
) as { [Name in PromptName]: PromptRegistry[Name]["path"] };

export const PROMPT_VERSIONS = Object.fromEntries(
  Object.entries(PROMPT_REGISTRY).map(([name, entry]) => [name, entry.version]),
) as { [Name in PromptName]: PromptRegistry[Name]["version"] };

export type LoadedPrompt = {
  name: PromptName;
  path: string;
  version: string;
  text: string;
  digest: string;
};

const loadedPrompts = new Map<PromptName, LoadedPrompt>();

/**
 * Load a static model instruction next to this module. The relative URL keeps
 * source and emitted runtime layouts equivalent and does not depend on cwd.
 */
export function loadPromptMetadata(name: PromptName): LoadedPrompt {
  const cached = loadedPrompts.get(name);
  if (cached !== undefined) return cached;

  const entry = PROMPT_REGISTRY[name];
  const fileName = entry.path.slice(entry.path.lastIndexOf("/") + 1);
  const path = fileURLToPath(new URL(`./promts/${fileName}`, import.meta.url));
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`prompt asset is unavailable: ${entry.path}`, { cause: error });
  }
  if (content.trim() === "") {
    throw new Error(`prompt asset is empty: ${entry.path}`);
  }
  const loaded: LoadedPrompt = {
    name,
    path: entry.path,
    version: entry.version,
    text: content,
    digest: createHash("sha256").update(content, "utf8").digest("hex"),
  };
  loadedPrompts.set(name, loaded);
  return loaded;
}

export function loadPrompt(name: PromptName): string {
  return loadPromptMetadata(name).text;
}
