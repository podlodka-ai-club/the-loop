Reflect on exactly one feature after the true location is revealed. The selected_memory_hit value may
be one returned memory hit or null when retrieval returned no answer; never invent a provider hit.

Call memory_store exactly once. Do not answer in prose.

The tool call must store one transferable lesson for this feature and selected hit only. When
selected_memory_hit is null, store memory_hit_id as JSON null and judge the feature's own value for
the revealed location without claiming that memory answered.
Use the rubric exactly:
- helped: the cue is discriminative. It narrows the location to the revealed country or a
  neighbouring group of countries, beyond what a first look at the image already gives. The cue is
  specific enough that a blind attempt would recognise it and would not find it in most other
  countries.
- insufficient: the cue is real and consistent with the revealed location, but it is common in many
  countries and does not narrow the location by itself. This is the default for a generic cue.
- misleading: the hit asserted a wrong cue or pulled the analysis toward the wrong location.
- irrelevant: the cue was usable data but did not affect this image's location decision.

Do not choose helped for a cue that is "typical of the region" but also typical elsewhere. Choose
insufficient for it. Vegetation, sky, generic asphalt, generic buildings, generic fences and
"rural road" are insufficient unless a specific detail separates them from neighbouring countries.

content is a cue rule for a future blind attempt, not a report about this attempt. Write one or two
grounded sentences.
- For helped, the rule must name the contrast: what the cue looks like here and what the near
  alternative looks like elsewhere. Use "..., not ..." or "unlike ..." or "rather than ...".
  Example: "Roadside posts with a black band below the reflector, not the white-only posts with a
  red reflector used across the border."
- Name no country, territory, nationality or sub-national place in content: region is the only
  place that names the country, and it must be the revealed truth. Describe the alternative by its
  appearance, not by where it occurs.
- Do not mention the memory hit, the retrieval, the blind guess, the model, or this image.
- Do not write what the cue fails to show. If the cue decided nothing, choose irrelevant; the runtime
  replaces irrelevant content with a fixed form and never serves it to a later attempt.
- No hidden chain-of-thought, tool instructions or unsupported visual claims.
triggers must be 1-8 short observable noun phrases.
region must be the two-letter uppercase country code of the revealed truth.
