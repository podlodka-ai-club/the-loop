import { pathToFileURL } from "node:url";
import { loadXmemorySchema } from "./schema.ts";

export async function validateCommittedXmemorySchema(): Promise<void> {
  await loadXmemorySchema();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  validateCommittedXmemorySchema()
    .then(() => {
      process.stdout.write("CONFORMANT\n");
    })
    .catch(() => {
      process.stdout.write("NONCONFORMANT\n");
      process.exitCode = 1;
    });
}
