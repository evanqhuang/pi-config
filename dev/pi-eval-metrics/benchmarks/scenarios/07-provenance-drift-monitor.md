# Source provenance and drift monitor

Build a provenance and source-drift review workflow for property records. It
should make stale or changed upstream evidence visible, preserve an auditable
history, and give the user a safe path to revalidate without overwriting local
review context.

Requirements:

1. Inventory existing provenance, source-drift, county/recorded-document
   snapshots, fixture/live boundaries, and property authorization helpers.
2. Define a normalized source record containing source identity, retrieval
   timestamp, content/version fingerprint, freshness policy, and provenance
   status without storing secrets or uncontrolled raw responses.
3. Detect unchanged, changed, stale, unavailable, malformed, and unapproved
   sources deterministically; preserve prior evidence and explain next steps.
4. Add an authenticated API and property UI for source history, drift review,
   acknowledge/revalidate actions, optimistic conflicts, and all error states.
5. Make revalidation durable and idempotent through the existing worker/task
   patterns, with safe retries and explicit manual-review fallbacks.
6. Add unit, emulator integration, and UI tests for fingerprints, retention,
   authorization, concurrent acknowledgement, provider failures, and fixture
   scenarios.
7. Document the data-retention and fail-closed semantics and run all relevant
   verification gates before reporting completion.
