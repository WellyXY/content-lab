# Blind Evaluation & Calibration Protocol V0.1

1. Construct train/reference and holdout sets, preventing near-identical original/replication leakage across them. Start with VN as one market. Cases that were discussed in framework formation are REFERENCE, not unbiased holdout tests.
2. Blind pass: hide registrations/CPA/views and any 'flop/winner' human labels from model. Score creative and expected registration separately using media alone; save output immutably with model version, prompt version, timestamp, input evidence IDs.
3. Outcome reveal: compare only among properly normalized cohorts (same market, channel, format where relevant, placement/goal, approximate time and budget). Compute CPA from spend / registrations rather than averaging row CPA. Small spends and single-digit conversions must be marked insufficient evidence.
4. Record unexpected cases with label 'unexpected outcome', not automatic model error: budget, targeting, attribution or ad delivery may explain differences. Assess spend thresholds with media buyer rather than inventing a universal cutoff.
5. Measure calibration by ranking high/low performance within matched groups, prediction vs volume/CPA/lifespan, qualitative evidence citation quality, and agreement with human corrections. Do not claim causal validation without controlled testing.
6. Collect explicit counterexamples: high watch / low registration, low watch / good registration, high-CTR photos, high-volume videos, failed copies, cross-market transfers.
7. Publish only reviewed case writeups. Keep human ratings as judgments and ad metrics as outcomes; no automatic overwriting of either.
