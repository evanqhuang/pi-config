# County-record refresh reliability

Extend the existing county-records workflow into a production-ready refresh
experience for watched properties. A user must be able to request an initial
resolve, confirm an ambiguous match, and refresh stale data without blocking
an HTTP request on the upstream provider.

Requirements:

1. Inspect the existing county provider, fixture scenarios, Firestore models,
   durable agent-task worker, and property UI before changing code.
2. Use an enqueue → claim → execute → project lifecycle with idempotency,
   leases, bounded retries, and explicit terminal outcomes.
3. Enforce authentication, watched-property authorization, revision checks,
   and indistinguishable responses for unauthorized records.
4. Preserve source provenance, fetched-at timestamps, stale-data semantics,
   and an actionable manual-review state for unsupported or ambiguous data.
5. Add UI for resolve/confirm/refresh, queued/running/succeeded/blocked/
   failed states, retry guidance, and stale indicators.
6. Cover provider failures, malformed data, concurrent edits, lease recovery,
   authorization, idempotency, and the fixture scenarios with tests.
7. Run focused tests, the prescribed reduced-parallelism integration suite,
   typecheck, build, and lint; document the workflow and stop semantics.
