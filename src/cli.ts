/** Usage: node src/cli.ts PHOTO */
import { geolocate, provider } from "./agent.ts";

const imagePath = process.argv[2];
if (!imagePath) {
  console.error("usage: node src/cli.ts PHOTO");
  process.exit(2);
}

try {
  const guess = await geolocate(imagePath);
  console.log(guess.place);
  console.log(`${guess.latitude.toFixed(4)}, ${guess.longitude.toFixed(4)}`);
  console.log(`https://www.google.com/maps?q=${guess.latitude},${guess.longitude}`);
  console.log(`confidence: ${guess.confidence}`);
  console.log(`why: ${guess.reasoning}`);
} finally {
  // Without this the process can exit before the exporter flushes the trace.
  await provider.shutdown();
}
