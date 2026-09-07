import type { NextConfig } from "next";

/**
 * The demo reads one JSON file out of `public/` and calls nothing. Static export
 * keeps it that way: `next build` produces a directory that opens from a file
 * server, so recording the screen does not depend on a running Node process.
 */
const config: NextConfig = {
  output: "export",
  agentRules: false,
  images: { unoptimized: true },
};

export default config;
