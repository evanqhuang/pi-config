# Screening-run comparison and retry

Extend screening runs into a reproducible comparison and retry experience.
Users should be able to understand which screening inputs produced a result,
compare revisions, retry only eligible failures, and distinguish a blocked
policy decision from an upstream failure.

Requirements:

1. Inspect screening input normalization, policy decisions, persisted run
   state, migration helpers, authz, and existing property UI/API patterns.
2. Add typed run summaries with immutable input/source revisions, deterministic
   result identity, timestamps, terminal outcome, and actionable reason codes.
3. Implement safe retry rules with CAS/idempotency; never retry a policy block
   or silently replace a newer run.
4. Add a comparison view that highlights changed inputs, sources, outcomes,
   and unresolved/manual-review items without making legal conclusions.
5. Cover loading, empty, queued, running, complete, blocked, failed, conflict,
   and unavailable states in the UI.
6. Add unit, persistence/integration, and UI tests for migrations, invalid
   inputs, authorization, retries, races, deterministic comparisons, and
   source failures.
7. Update docs and run focused/full tests, typecheck, build, and lint cleanly.
