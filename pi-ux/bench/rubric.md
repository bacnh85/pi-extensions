# pi-ux design rubric — fixed scoring for every bench run

Score each rendered page (`desktop-full.png`, `mobile-full.png`) on six axes,
**1–5 each, half-points allowed**. Score what a viewer sees, not the code.
The judge and rubric stay constant across runs so deltas measure the tool, not
the judge. Record ux_audit's pass/fail from `session.jsonl` separately.

## Axes

**Hierarchy (1–5)** — Is there an obvious first thing to look at, a clear
reading order, and real size/weight contrast between levels?
1. everything the same size; eye wanders · 3. headings bigger but timid; order
ambiguous in places · 5. squint-test: three distinct levels, eye lands right,
scanning order is inevitable.

**Composition (1–5)** — Layout dynamics: section rhythm, spacing as
expression, asymmetry/intentional structure, no dead zones or mechanical
sameness.
1. one centered column, uniform boxes · 3. competent bands but equal weight
throughout · 5. sections alternate in weight and treatment; whitespace is
shaped, not leftover; the layout itself expresses the subject.

**Typography (1–5)** — Deliberate, subject-fitting type with real scale
contrast; comfortable measure; personality.
1. system-ui/Inter everywhere, timid sizes · 3. one display font but generic
choice/sizing · 5. a defensible pairing that carries the subject's voice;
display type is bold enough to be a feature; body is a pleasure.

**Color & mood (1–5)** — A palette derived from the subject with a
temperature/tint point of view; accent used with discipline; atmosphere.
1. white bg, default blue accent, gray text · 3. tasteful but safe neutrals
plus one accent; no mood · 5. the palette alone says what the product is;
neutrals are tinted deliberately; the page has atmosphere without slop.

**Copy (1–5)** — Real, specific, subject-grounded words. Headlines say
something; CTAs say what happens.
1. "Features / Get Started / Learn more" boilerplate · 3. correct but generic
SaaS voice · 5. could only belong to this product; microcopy (empty states,
badges, errors) is written too.

**Feel (holistic, 1–5)** — Would a design lead ship this? Is there one clear
idea carrying the page? Is it memorable?
1. a template with the serial numbers filed off · 3. clean, competent,
forgettable · 5. one memorable idea, executed with discipline; you'd remember
this page next week.

## Reporting

`SCORES.md` per run: per-brief table (six axis scores, total /30, ux_audit
pass/fail, notable evidence in one line each), then run total and delta vs the
previous run. One shortlist of the three biggest observable weaknesses feeds
the next improvement iteration.
