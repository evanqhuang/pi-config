# Recorded-document search review

Build a durable recorded-document search and review workflow for a property.
The workflow should search the required deed, lien, tax-lien, and foreclosure
indices through the existing queued agent-task architecture and make the
results useful without presenting a legal conclusion.

Requirements:

1. Map the existing recorded-documents provider contract, fixture scenarios,
   source-approval gates, task worker, and property deep-dive patterns.
2. Make searches deterministic per property and county revision, idempotent
   on repeat requests, and safe against stale revision updates.
3. Model every required index as complete, not-applicable, blocked, or
   failed, with per-index reasons and manual next steps.
4. Enforce auth and property ownership on enqueue, polling, and result access;
   fail closed when live automation is not approved.
5. Add a UI with request, polling, partial-result, empty, blocked, failed,
   manual-review, and complete states.
6. Add focused unit/UI tests plus emulator integration coverage for pagination,
   ambiguous parties, access blocks, outages, malformed responses, idempotency,
   and cross-user isolation.
7. Update source-contract and feature documentation, then run all applicable
   verification gates and fix regressions before reporting completion.
