# Notes

## How to teach me

- Short replies. Answer in the first sentence. Bullets over prose.
- Simplified Technical English. One idea per sentence. Active voice.
- No preamble, no closing summary.

## Established starting point

- Comfortable with TypeScript, Node, ESM, `openai` client.
- Already wired Phoenix tracing by hand, including the ESM
  `manuallyInstrument` workaround in `src/tracing.ts`. That is not beginner
  work, so do not re-teach OpenTelemetry basics.
- Already ported a Python script to TypeScript and added
  `UnparseableOutputError` to keep format failures separate from accuracy
  failures. That shows eval instinct before any eval existed.

## Open flags

- `tmp/datasets/osv5m/test.csv` has ground-truth `latitude` and `longitude`,
  plus `country`, `region`, `sub-region`, `city`. Coordinate metrics and
  administrative metrics are both available.
- `tmp/datasets/osv5m/train.csv` is 2.7 GB. Never load it whole.
- Security: `tmp/geolocate.py` line 61 contains a live Cerebras API key in
  plain text. `tmp` is gitignored, so it is not committed, but the key is on
  disk and was in a file that could be shared. Rotate it.
