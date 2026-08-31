# Mission: Evaluating a vision-LLM geolocation agent

> Status: DRAFT. I wrote this from the code in this repo, not from your words.
> Correct it, then delete this block.

## Why

I have a working geolocation agent (`src/agent.ts`) that turns one street-view
photo into a latitude, a longitude and a confidence. I do not know if it is any
good, and I cannot tell if a prompt change made it better or worse. I want an
eval harness that answers both questions with numbers I trust.

## Success looks like

- I can state the agent's score on a held-out split of OSV-5M in three numbers,
  and defend each one.
- I can change `PROMPT` in `src/agent.ts`, re-run one command, and see whether
  the change helped or hurt.
- I can tell a real regression from sampling noise, and I know my sample size.
- I can name the failure modes behind the score, not only the score.
- I can spot when a good score comes from memorisation instead of reasoning.

## Constraints

- Stack is fixed: TypeScript, Node, `openai` client against Cerebras, Phoenix
  for traces (`src/tracing.ts`).
- Data is on disk already: `tmp/datasets/osv5m/test.csv` plus `images/test`.
- Every API call costs money and time. The harness must run on a sample.
- Lessons must be short. One tangible win each.

## Out of scope

- Training or fine-tuning a geolocation model.
- Making the agent better. I want to measure first.
- Human-in-the-loop or LLM-judge scoring of the `reasoning` field, until the
  coordinate metrics are trustworthy.
