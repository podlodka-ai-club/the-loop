export function readCliOption(
  name: string,
  fallback: string,
  argv: readonly string[] = process.argv,
): string {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

export function parsePositiveSafeIntegerOption(
  name: string,
  raw: string,
  options: { max?: number } = {},
): number {
  return parseSafeIntegerOption(name, raw, { min: 1, ...options });
}

export function parseNonNegativeSafeIntegerOption(
  name: string,
  raw: string,
  options: { max?: number } = {},
): number {
  return parseSafeIntegerOption(name, raw, { min: 0, ...options });
}

function parseSafeIntegerOption(
  name: string,
  raw: string,
  options: { min: number; max?: number },
): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`--${name} must be a safe integer >= ${options.min}`);
  }
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < options.min ||
    (options.max !== undefined && value > options.max)
  ) {
    throw new Error(
      `--${name} must be a safe integer ` +
        (options.max === undefined ? `>= ${options.min}` : `from ${options.min} to ${options.max}`),
    );
  }
  return value;
}
