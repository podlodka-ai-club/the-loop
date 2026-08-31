# Geolocation agent evaluation resources

Every entry below was fetched and read, not recalled. Annotations say when to
reach for the source.

## Knowledge

### The benchmark and its metrics

- [Paper: _OpenStreetView-5M: The Many Roads to Global Visual Geolocation_ (CVPR 2024)](https://arxiv.org/abs/2404.18873)
  The dataset in `tmp/datasets/osv5m`. 5.1M street-view images, 225 countries,
  strict train/test separation. Use for: why the test split is the only honest
  split, and what the authors measure.
- [Project site: osv5m.github.io](https://osv5m.github.io/)
  Metric definitions and the leaderboard. Use for: the numbers to compare
  against.
- [Model card: osv5m/baseline on Hugging Face](https://huggingface.co/osv5m/baseline)
  The published baseline: GeoScore 3361, mean haversine 1814 km, country
  accuracy 68%. Use for: is my agent better or worse than a trained model.
- [Repo: gastruc/osv5m](https://github.com/gastruc/osv5m)
  Reference implementation of the metrics. Use for: checking my haversine and
  GeoScore code against theirs.
- [Paper: _Image-Based Geolocation Using Large Vision-Language Models_ (arXiv 2408.09474)](https://arxiv.org/pdf/2408.09474)
  Section E defines haversine distance, GeoScore and threshold accuracy for
  vision-LLM geolocation. Closest published setup to this repo. Use for: metric
  formulas and the privacy framing.
- [Paper: _GaGA: Towards Interactive Global Geolocation Assistant_ (arXiv 2412.08907)](https://arxiv.org/html/2412.08907v1)
  Uses the 1 / 25 / 200 / 750 / 2500 km threshold ladder. Use for: what each
  rung means, and comparable LLM-era numbers.
- [Paper: _Assessing the Geolocation Capabilities, Limitations and Societal Risks of Generative Vision-Language Models_ (arXiv 2508.19967)](https://arxiv.org/pdf/2508.19967)
  Use for: contamination, refusal behaviour and the ethics of this task.
- [Article: _The maths of GeoGuessr_](https://latb.io/geoguessr/articles/the-maths)
  Where the exponential score curve comes from, in the game itself. Use for:
  intuition about why GeoScore compresses large errors.

### The harness

- [Docs: Phoenix datasets and experiments quickstart](https://arize.com/docs/phoenix/datasets-and-experiments/quickstart-datasets)
  Dataset, task, evaluator, experiment. The shape my harness should take.
- [README: @arizeai/phoenix-client](https://github.com/Arize-ai/phoenix/blob/main/js/packages/phoenix-client/README.md)
  The TypeScript API: `createDataset`, `runExperiment`, `asExperimentEvaluator`,
  and the Vitest submodule for eval tests in CI. Use for: exact call signatures.
  This is the client that matches this repo's language.
- [Docs: Phoenix evaluation overview](https://arize.com/docs/phoenix/evaluation/llm-evals)
  Use for: when a code evaluator is enough and when an LLM judge earns its cost.

## Wisdom (Communities)

- [r/geoguessr](https://www.reddit.com/r/geoguessr/)
  Human players who read the same visual clues the agent must read. Use for:
  building a list of clues to test, and for sanity-checking hard images.
- [Plonk demo on Hugging Face Spaces](https://huggingface.co/spaces/osv5m/plonk)
  The paper authors' own demo. Play it. Use for: calibrating your own
  difficulty judgement before you judge the agent's.
- [Arize Phoenix Slack](https://arize-ai.slack.com/)
  Maintainers answer harness questions. Use for: experiment API problems.

## Gaps

- No trusted source yet on sample-size choice for coordinate-error evals. Need
  a bootstrap-confidence-interval reference before lesson 4.
- No trusted source yet on confidence calibration for regression outputs, which
  is what the agent's `confidence` field needs.
