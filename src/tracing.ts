/**
 * Phoenix tracing setup. Import this before anything calls the OpenAI client.
 *
 * `register()` builds a NodeTracerProvider, points an OTLP exporter at the local
 * Phoenix server and installs it as the global provider.
 */
import { OpenAIInstrumentation } from "@arizeai/openinference-instrumentation-openai";
import { register } from "@arizeai/phoenix-otel";
import OpenAI from "openai";

export const provider = register({
  projectName: process.env.PHOENIX_PROJECT ?? "geolocate",
  url: process.env.PHOENIX_COLLECTOR_ENDPOINT ?? "http://localhost:6006",
  // One-shot CLI: export every span as it ends instead of on a batch timer.
  batch: false,
  global: true,
});

// register()'s `instrumentations` option only works under CommonJS. Under ESM the
// module has to be patched by hand, after the global provider exists and before
// the first `chat.completions.create` call.
//
// base64ImageMaxLength defaults to 32_000 chars, which redacts every photo we send
// (a 50 KB JPEG is ~67_000 chars of base64) and leaves the trace with no image to
// look at. Raise it so the photo renders in the span detail view.
new OpenAIInstrumentation({
  traceConfig: {
    base64ImageMaxLength: Number(process.env.OPENINFERENCE_BASE64_IMAGE_MAX_LENGTH ?? 1_000_000),
  },
}).manuallyInstrument(OpenAI);
